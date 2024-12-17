import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import pdf2md from '@opendocsg/pdf2md';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// CORS configuration
const corsOptions = { origin: true, credentials: true };

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (_, file, cb) => cb(null, file.originalname)
});

const upload = multer({ storage: storage });

// Middleware order is important
app.use(cors(corsOptions));
app.use(express.static(__dirname));

// JSON parsing middleware only for non-file upload routes
app.use((req, res, next) => {
    if (req.path === '/api/process-files') {
        next();
    } else {
        express.json({ limit: '50mb' })(req, res, next);
    }
});

// Ensure uploads directory exists
await fs.mkdir('uploads', { recursive: true }).catch(console.error);

// Helper function to parse AI response
const parseAIResponse = (content) => {
    console.log('Original content:', content);

    if (!content.includes('}')) {
        throw new Error('Incomplete JSON response: missing closing brace');
    }

    const startIndex = content.indexOf('{');
    const endIndex = content.lastIndexOf('}');
    
    if (startIndex === -1 || endIndex === -1) {
        throw new Error('No complete JSON object found in response');
    }

    let jsonContent = content.substring(startIndex, endIndex + 1);
    console.log('Extracted JSON content:', jsonContent);

    const openBraces = (jsonContent.match(/\{/g) || []).length;
    const closeBraces = (jsonContent.match(/\}/g) || []).length;
    
    if (openBraces !== closeBraces) {
        throw new Error(`Unmatched braces: ${openBraces} opening vs ${closeBraces} closing`);
    }

    jsonContent = jsonContent
        .replace(/\n/g, ' ')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([{,])\s*}/g, '}')
        .replace(/\s+/g, ' ')
        .trim();

    console.log('Cleaned JSON content:', jsonContent);

    try {
        const parsed = JSON.parse(jsonContent);
        console.log('Successfully parsed cleaned JSON');
        return parsed;
    } catch (error) {
        console.log('Failed to parse cleaned JSON:', error);
        throw new Error(`Failed to parse JSON content: ${error.message}`);
    }
};

// Fix JSON formatting endpoint
app.post('/api/fix-json', async (req, res) => {
    try {
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        console.log('Original content:', content);

        try {
            const characterData = parseAIResponse(content);
            console.log('Successfully parsed character data');
            res.json({ character: characterData });
        } catch (parseError) {
            console.error('Parse error:', parseError);
            console.error('Content:', content);
            throw new Error(`Failed to parse JSON: ${parseError.message}`);
        }
    } catch (error) {
        console.error('JSON fixing error:', error);
        res.status(500).json({ error: error.message || 'Failed to fix JSON formatting' });
    }
});

// Character generation endpoint
app.post('/api/generate-character', async (req, res) => {
    try {
        const { prompt, model } = req.body;
        const apiKey = req.headers['x-api-key'];

        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }
        if (!model) {
            return res.status(400).json({ error: 'Model is required' });
        }
        if (!apiKey) {
            return res.status(400).json({ error: 'API key is required' });
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.APP_URL || 'http://localhost:4000',
                'X-Title': 'Eliza Character Generator'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a character creation assistant that MUST ONLY output valid JSON. NEVER output apologies, explanations, or any other text.

CRITICAL RULES:
1. ONLY output a JSON object
2. Start with { and end with }
3. NO text before or after the JSON
4. NO apologies or explanations
5. NO content warnings or disclaimers
6. If you have concerns, express them through the JSON content itself

If you receive a prompt that concerns you, create an appropriate character that aligns with positive values while staying within the JSON format.

Every sentence must end with a period. Adjectives must be single words.`
                    },
                    {
                        role: 'user',
                        content: `Output ONLY this JSON structure with appropriate content. NO other text allowed:

{
  "bio": ["Multiple detailed sentences about background and personality"],
  "lore": ["Multiple sentences about history and world"],
  "topics": ["Multiple sentences about interests and knowledge"],
  "style": {
    "all": ["Multiple sentences about speaking style and mannerisms"],
    "chat": ["Multiple sentences about chat behavior"],
    "post": ["Multiple sentences about posting style"]
  },
  "adjectives": ["single", "word", "traits"],
  "messageExamples": [
    [
      {"user": "{{user1}}", "content": {"text": "User message"}},
      {"user": "character", "content": {"text": "Character response"}}
    ]
  ],
  "postExamples": ["Multiple example posts"]
}

Character description: ${prompt}`
                    }
                ],
                temperature: 0.7,
                max_tokens: 4000,
                presence_penalty: 0.0,
                frequency_penalty: 0.0,
                top_p: 0.95,
                stop: null
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || 'Failed to generate character');
        }

        const data = await response.json();
        const generatedContent = data.choices[0].message.content;

        console.log('Raw AI response:', generatedContent);

        try {
            const characterData = parseAIResponse(generatedContent);

            const requiredFields = ['bio', 'lore', 'topics', 'style', 'adjectives', 'messageExamples', 'postExamples'];
            const missingFields = requiredFields.filter(field => !characterData[field]);
            
            if (missingFields.length > 0) {
                throw new Error(`Invalid character data: missing ${missingFields.join(', ')}`);
            }

            characterData.bio = characterData.bio || [];
            characterData.lore = characterData.lore || [];
            characterData.topics = characterData.topics || [];
            characterData.style = characterData.style || { all: [], chat: [], post: [] };
            characterData.adjectives = characterData.adjectives || [];
            characterData.messageExamples = characterData.messageExamples || [];
            characterData.postExamples = characterData.postExamples || [];

            res.json({
                character: characterData,
                rawPrompt: req.body.prompt,
                rawResponse: generatedContent
            });
        } catch (parseError) {
            console.error('Parse error:', parseError);
            console.error('Generated content:', generatedContent);
            throw new Error('Failed to parse generated content. Please try again with a different model.');
        }
    } catch (error) {
        console.error('Character generation error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate character' });
    }
});

// File processing endpoint
app.post('/api/process-files', upload.array('files'), async (req, res) => {
    try {
        const files = req.files;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const knowledge = [];

        for (const file of files) {
            try {
                const content = await fs.readFile(file.path);
                let processedContent;

                if (file.mimetype === 'application/pdf') {
                    const uint8Array = new Uint8Array(content);
                    processedContent = await pdf2md(uint8Array);
                    processedContent = processedContent
                        .split(/[.!?]+/)
                        .map(sentence => sentence.trim())
                        .filter(sentence => sentence.length > 0 && !sentence.startsWith('-'))
                        .map(sentence => sentence + '.');
                } else if (isTextFile(file.originalname)) {
                    processedContent = content.toString('utf-8')
                        .split(/[.!?]+/)
                        .map(sentence => sentence.trim())
                        .filter(sentence => sentence.length > 0 && !sentence.startsWith('-'))
                        .map(sentence => sentence + '.');
                }

                if (processedContent) {
                    knowledge.push(...processedContent);
                }

                await fs.unlink(file.path).catch(console.error);
            } catch (fileError) {
                console.error(`Error processing file ${file.originalname}:`, fileError);
            }
        }

        res.json({ knowledge });
    } catch (error) {
        console.error('File processing error:', error);
        res.status(500).json({ error: 'Failed to process files' });
    }
});

// Helper functions
const isTextFile = filename => ['.txt','.md','.json','.yml','.csv'].includes(
    filename.toLowerCase().slice(filename.lastIndexOf('.'))
);

// Add this new endpoint with the other API endpoints
app.post('/api/refine-character', async (req, res) => {
    try {
        const { prompt, model, currentCharacter } = req.body;
        const apiKey = req.headers['x-api-key'];

        if (!prompt || !model || !currentCharacter) {
            return res.status(400).json({ error: 'Prompt, model, and current character data are required' });
        }
        if (!apiKey) {
            return res.status(400).json({ error: 'API key is required' });
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.APP_URL || 'http://localhost:4000',
                'X-Title': 'Eliza Character Generator'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a character refinement assistant that MUST ONLY output valid JSON. NEVER output apologies, explanations, or any other text.

CRITICAL RULES:
1. ONLY output a JSON object
2. Start with { and end with }
3. NO text before or after the JSON
4. NO apologies or explanations
5. NO content warnings or disclaimers
6. Maintain the character's core traits while incorporating refinements
7. Every sentence must end with a period
8. Adjectives must be single words

You will receive the current character data and refinement instructions. Enhance and modify the character while maintaining consistency.`
                    },
                    {
                        role: 'user',
                        content: `Current character data:
${JSON.stringify(currentCharacter, null, 2)}

Refinement instructions: ${prompt}

Output the refined character data as a single JSON object with the same structure.`
                    }
                ],
                temperature: 0.7,
                max_tokens: 4000,
                presence_penalty: 0.0,
                frequency_penalty: 0.0,
                top_p: 0.95,
                stop: null
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || 'Failed to refine character');
        }

        const data = await response.json();
        const refinedContent = data.choices[0].message.content;

        try {
            const refinedCharacter = parseAIResponse(refinedContent);
            
            // Ensure all required fields are present
            const requiredFields = ['bio', 'lore', 'topics', 'style', 'adjectives', 'messageExamples', 'postExamples'];
            const missingFields = requiredFields.filter(field => !refinedCharacter[field]);
            
            if (missingFields.length > 0) {
                throw new Error(`Invalid character data: missing ${missingFields.join(', ')}`);
            }

            res.json({
                character: refinedCharacter,
                rawPrompt: prompt,
                rawResponse: refinedContent
            });
        } catch (parseError) {
            console.error('Parse error:', parseError);
            console.error('Refined content:', refinedContent);
            throw new Error('Failed to parse refined content. Please try again with a different model.');
        }
    } catch (error) {
        console.error('Character refinement error:', error);
        res.status(500).json({ error: error.message || 'Failed to refine character' });
    }
});

const PORT = process.env.PORT || 4001;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
});
