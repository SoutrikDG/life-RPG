/**
 * API BRIDGE: GITHUB PAGES -> GOOGLE SHEETS
 * Handles all network communication.
 */

const API_CONFIG = {
    // 🔴 INSTRUCTION: Paste your new Web App URL (ending in /exec) here
    URL: "https://script.google.com/macros/s/AKfycbz7KlHslXP9L84E9CasPcjitXKf78g2ykPI8DcUXqgvkMN78znjiRuby03qcyybei3wnw/exec", 
    
    // Optional: Leave empty unless you implement auth later
    TOKEN: ""
};

/**
 * HELPER: Centralized Fetcher for GET requests
 */
async function fetchData(action) {
    try {
        const url = `${API_CONFIG.URL}?action=${action}`;
        const response = await fetch(url);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error(`Failed to fetch ${action}:`, error);
        return null;
    }
}

/**
 * HELPER: Centralized Sender for POST requests
 * Note: Uses 'no-cors' mode because Google redirects POSTs. 
 * We assume success if the network call doesn't fail.
 */
async function sendPost(payload) {
    try {
        // Inject Auth Token if it exists
        if (API_CONFIG.TOKEN) payload.auth_token = API_CONFIG.TOKEN;

        await fetch(API_CONFIG.URL, {
            method: "POST",
            mode: "no-cors", 
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });
        return true;
    } catch (error) {
        console.error("Post Error:", error);
        throw error;
    }
}

/* =========================================
   PUBLIC WRAPPERS (Used by app.js)
   ========================================= */

// 1. Fetch Habits
async function fetchHabits() {
    const data = await fetchData("GET_HABITS");
    return data ? data.habits : [];
}

// 2. Fetch Stats
async function getStats() {
    const data = await fetchData("GET_STATS");
    return data ? data.stats : {};
}

// 3. Save Habit (Create/Edit)
async function saveHabit(habitData) {
    return sendPost({ action: "SAVE_HABIT", ...habitData });
}

// 4. Log Activity
async function postLog(data) {
    return sendPost({ action: "LOG", ...data });
}