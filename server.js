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

    try {
        // First try direct JSON parse
        return JSON.parse(content);
    } catch (directParseError) {
        console.log('Direct parse failed, attempting cleanup');

        // Find the JSON object boundaries
        const startIndex = content.indexOf('{');
        const endIndex = content.lastIndexOf('}');
        
        if (startIndex === -1 || endIndex === -1) {
            throw new Error('No complete JSON object found in response');
        }

        let jsonContent = content.substring(startIndex, endIndex + 1);
        
        // Clean up common issues
        jsonContent = jsonContent
            .replace(/,\s*}/g, '}')  // Remove trailing commas
            .replace(/,\s*]/g, ']')  // Remove trailing commas in arrays
            .replace(/\{\s*\}/g, '{}')  // Normalize empty objects
            .replace(/\[\s*\]/g, '[]')  // Normalize empty arrays
            .replace(/"\s*:\s*undefined/g, '": null')  // Replace undefined with null
            .replace(/"\s*:\s*,/g, '": null,')  // Fix empty values
            .replace(/"\s*:\s*}/g, '": null}')  // Fix empty values at end
            .replace(/\n/g, ' ')  // Remove newlines
            .replace(/\s+/g, ' ')  // Normalize whitespace
            .trim();

        console.log('Cleaned JSON content:', jsonContent);

        try {
            return JSON.parse(jsonContent);
        } catch (cleanupParseError) {
            console.error('Parse error after cleanup:', cleanupParseError);
            throw new Error(`Failed to parse JSON content: ${cleanupParseError.message}`);
        }
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

        // Extract potential name from the prompt
        const nameMatch = prompt.match(/name(?:\s+is)?(?:\s*:)?\s*([A-Z][a-zA-Z\s]+?)(?:\.|\s|$)/i);
        const suggestedName = nameMatch ? nameMatch[1].trim() : '';

        // Create a template for consistent structure
        const template = {
            name: suggestedName,
            clients: [],
            modelProvider: "",
            settings: {
                secrets: {},  // Changed from empty object to properly nested structure
                voice: {
                    model: ""
                }
            },
            plugins: [],
            bio: [],
            lore: [],
            knowledge: [],
            messageExamples: [],
            postExamples: [],
            topics: [],
            style: {
                all: [],
                chat: [],
                post: []
            },
            adjectives: [],
            people: []
        };

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
                        content: `You are a character generation assistant that MUST ONLY output valid JSON. NEVER output apologies, explanations, or any other text.

CRITICAL RULES:
1. ONLY output a JSON object following the exact template structure provided
2. Start with { and end with }
3. NO text before or after the JSON
4. NO apologies or explanations
5. NO content warnings or disclaimers
6. Every sentence must end with a period
7. Adjectives must be single words
8. Extract knowledge from the prompt and create knowledge entries
9. Use the suggested name if provided, or generate an appropriate one

You will receive a character description and template. Generate a complete character profile.`
                    },
                    {
                        role: 'user',
                        content: `Template to follow:
${JSON.stringify(template, null, 2)}

Character description: ${prompt}

Generate a complete character profile as a single JSON object following the exact template structure. Include relevant knowledge entries based on the description.`
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

        try {
            console.log('Raw AI response:', generatedContent);
            const characterData = parseAIResponse(generatedContent);
            console.log('Parsed character:', characterData);

            // Ensure all required fields are present
            const requiredFields = ['bio', 'lore', 'topics', 'style', 'adjectives', 'messageExamples', 'postExamples'];
            const missingFields = requiredFields.filter(field => !characterData[field]);
            
            if (missingFields.length > 0) {
                throw new Error(`Invalid character data: missing ${missingFields.join(', ')}`);
            }

            // Ensure all arrays are present and properly initialized
            characterData.bio = characterData.bio || [];
            characterData.lore = characterData.lore || [];
            characterData.topics = characterData.topics || [];
            characterData.knowledge = characterData.knowledge || [];
            characterData.messageExamples = characterData.messageExamples || [];
            characterData.postExamples = characterData.postExamples || [];
            characterData.adjectives = characterData.adjectives || [];
            characterData.people = characterData.people || [];
            characterData.style = characterData.style || { all: [], chat: [], post: [] };

            res.json({
                character: characterData,
                rawPrompt: prompt,
                rawResponse: generatedContent
            });
        } catch (parseError) {
            console.error('Parse error:', parseError);
            console.error('Generated content:', generatedContent);
            throw new Error(`Failed to parse generated content: ${parseError.message}`);
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

        // Store existing knowledge and name
        const hasExistingKnowledge = Array.isArray(currentCharacter.knowledge) && currentCharacter.knowledge.length > 0;
        const existingKnowledge = currentCharacter.knowledge || [];
        const existingName = currentCharacter.name || "";

        // Extract potential new name from the prompt
        const nameMatch = prompt.match(/name(?:\s+is)?(?:\s*:)?\s*([A-Z][a-zA-Z\s]+?)(?:\.|\s|$)/i);
        const newName = nameMatch ? nameMatch[1].trim() : existingName;

        // Create a template for the AI to follow
        const template = {
            name: newName,
            clients: currentCharacter.clients || [],
            modelProvider: currentCharacter.modelProvider || "",
            settings: currentCharacter.settings || { secrets: {}, voice: { model: "" } },
            plugins: currentCharacter.plugins || [],
            bio: [],
            lore: [],
            knowledge: hasExistingKnowledge ? existingKnowledge : [],
            messageExamples: [],
            postExamples: [],
            topics: [],
            style: {
                all: [],
                chat: [],
                post: []
            },
            adjectives: [],
            people: currentCharacter.people || []
        };

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
1. ONLY output a JSON object following the exact template structure provided
2. Start with { and end with }
3. NO text before or after the JSON
4. NO apologies or explanations
5. NO content warnings or disclaimers
6. Maintain the character's core traits while incorporating refinements
7. Every sentence must end with a period
8. Adjectives must be single words
9. ${hasExistingKnowledge ? 'DO NOT modify or remove existing knowledge entries' : 'Create new knowledge entries based on the refinement instructions'}
10. Use the new name if provided in the refinement instructions

You will receive the current character data and refinement instructions. Enhance and modify the character while maintaining consistency.`
                    },
                    {
                        role: 'user',
                        content: `Current character data:
${JSON.stringify(currentCharacter, null, 2)}

Template to follow:
${JSON.stringify(template, null, 2)}

Refinement instructions: ${prompt}

Output the refined character data as a single JSON object following the exact template structure. ${hasExistingKnowledge ? 'DO NOT modify the existing knowledge array.' : 'Create new knowledge entries if appropriate.'}`
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
            console.log('Raw AI response:', refinedContent);
            const refinedCharacter = parseAIResponse(refinedContent);
            console.log('Parsed character:', refinedCharacter);
            
            // Ensure all required fields are present
            const requiredFields = ['bio', 'lore', 'topics', 'style', 'adjectives', 'messageExamples', 'postExamples'];
            const missingFields = requiredFields.filter(field => !refinedCharacter[field]);
            
            if (missingFields.length > 0) {
                throw new Error(`Invalid character data: missing ${missingFields.join(', ')}`);
            }

            // If there's existing knowledge, preserve it
            // Otherwise, use any new knowledge created by the AI
            if (hasExistingKnowledge) {
                refinedCharacter.knowledge = existingKnowledge;
            }

            // Ensure all arrays are present
            refinedCharacter.bio = refinedCharacter.bio || [];
            refinedCharacter.lore = refinedCharacter.lore || [];
            refinedCharacter.topics = refinedCharacter.topics || [];
            refinedCharacter.messageExamples = refinedCharacter.messageExamples || [];
            refinedCharacter.postExamples = refinedCharacter.postExamples || [];
            refinedCharacter.adjectives = refinedCharacter.adjectives || [];
            refinedCharacter.people = refinedCharacter.people || [];
            refinedCharacter.style = refinedCharacter.style || { all: [], chat: [], post: [] };

            res.json({
                character: refinedCharacter,
                rawPrompt: prompt,
                rawResponse: refinedContent
            });
        } catch (parseError) {
            console.error('Parse error:', parseError);
            console.error('Refined content:', refinedContent);
            throw new Error(`Failed to parse refined content: ${parseError.message}`);
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
