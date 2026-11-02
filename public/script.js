// Empty means "same server that served this page", which works both locally and when hosted
const API_BASE_URL = "";

async function handleSearch() {
    const query = document.getElementById('searchInput').value.trim();
    const container = document.getElementById('resultsContainer');
    const resultTitle = document.getElementById('resultTitle');

    if (!query) return;

    const sites = [...document.querySelectorAll('input[name="site"]:checked')].map(box => box.value);
    if (!sites.length) {
        container.innerHTML = `<div class="no-results">Select at least one site to search.</div>`;
        resultTitle.innerText = '';
        return;
    }

    container.innerHTML = `<div class="no-results">Fetching live prices from retailers... (this may take a few seconds)</div>`;
    resultTitle.innerText = `Results for "${query}"`;

    try {
        const response = await fetch(`${API_BASE_URL}/api/search?q=${encodeURIComponent(query)}&sites=${sites.join(',')}`);
        
        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        const products = await response.json();
        console.log("Fetched products:", products); // Check browser console (F12) to see this!

        container.innerHTML = '';

        if (!products || products.length === 0) {
            const q = encodeURIComponent(query);
            container.innerHTML = `<div class="no-results">No live listings found for this search. (Try a broader keyword like "iphone" or "mouse")<br><br>
                Search directly:
                <a href="https://www.startech.com.bd/product/search?search=${q}" target="_blank">Star Tech</a> ·
                <a href="https://www.ryans.com/search?q=${q}" target="_blank">Ryans</a> ·
                <a href="https://www.daraz.com.bd/catalog/?q=${q}" target="_blank">Daraz</a> ·
                <a href="https://www.rokomari.com/search?term=${q}&search_type=ALL" target="_blank">Rokomari</a></div>`;
            return;
        }

        // Sort ascending so the cheapest product is at the top; items without a known price go last
        products.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

        products.forEach((product, index) => {
            const hasPrice = product.price != null;
            const isCheapest = index === 0 && hasPrice;
            
            const card = document.createElement('div');
            card.className = `product-card ${isCheapest ? 'cheapest' : ''}`;
            
            card.innerHTML = `
                ${isCheapest ? '<div class="badge-cheapest">🔥 Cheapest Choice</div>' : ''}
                <div class="product-info">
                    <img src="${product.image || 'https://placehold.co/150'}" alt="${product.name}">
                    <div class="details">
                        <h3>${product.name}</h3>
                        <span class="store-name">Retailer: <strong>${product.store || 'Online Store'}</strong></span>
                    </div>
                </div>
                <div class="pricing">
                    <div>
                        <div class="price">${hasPrice ? `৳${Number(product.price).toLocaleString('en-IN')}` : 'See price on site'}</div>
                        <div class="delivery">${product.delivery || 'Check site'}</div>
                    </div>
                    <a href="${product.link}" target="_blank" class="btn-visit">Go to Store</a>
                </div>
            `;
            
            container.appendChild(card);
        });

    } catch (error) {
        console.error("Frontend Fetch Error:", error);
        container.innerHTML = `<div class="no-results" style="color: red;">Could not connect to backend server. Please try again in a moment.</div>`;
    }
}

document.getElementById('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSearch();
});

// Remember which sites were picked between visits
const siteBoxes = document.querySelectorAll('input[name="site"]');
const savedSites = JSON.parse(localStorage.getItem('sites') || 'null');
if (savedSites) siteBoxes.forEach(box => { box.checked = savedSites.includes(box.value); });
siteBoxes.forEach(box => box.addEventListener('change', () => {
    localStorage.setItem('sites', JSON.stringify([...siteBoxes].filter(b => b.checked).map(b => b.value)));
}));
