const TOKEN_UPDATE_INTERVAL = 30000; // Update every 30 seconds

async function fetchTokenInfo() {
    try {
        // Using our proxy endpoint
        const response = await fetch('/api/token-price');
        const data = await response.json();
        const tokenData = data.ai16z;

        if (tokenData) {
            updateTokenDisplay({
                price: tokenData.usd,
                change: tokenData.usd_24h_change,
                marketCap: tokenData.usd_market_cap,
                volume: tokenData.usd_24h_vol,
                // These values might need to be fetched from a different source
                supply: "1.09B",
                supplyPercent: "100"
            });
        }
    } catch (error) {
        console.error('Error fetching token data:', error);
        updateTokenDisplay({
            error: true
        });
    }
}

function formatNumber(num) {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
}

function updateTokenDisplay(data) {
    const priceElement = document.querySelector('.token-price');
    const marketCapElement = document.querySelector('.token-info-item:nth-child(2) p');
    const volumeElement = document.querySelector('.token-info-item:nth-child(3) p');
    
    if (data.error) {
        priceElement.innerHTML = '<span class="error">Unable to fetch price</span>';
        return;
    }

    // Update price and change
    const changeClass = data.change >= 0 ? 'positive' : 'negative';
    const changeSign = data.change >= 0 ? '+' : '';
    priceElement.innerHTML = `$${data.price.toFixed(4)} <span class="token-change ${changeClass}">${changeSign}${data.change.toFixed(2)}%</span>`;

    // Update market cap
    marketCapElement.textContent = `$${formatNumber(data.marketCap)}`;

    // Update volume
    volumeElement.textContent = `$${formatNumber(data.volume)}`;
}

// Initial fetch
fetchTokenInfo();

// Set up periodic updates
setInterval(fetchTokenInfo, TOKEN_UPDATE_INTERVAL); 