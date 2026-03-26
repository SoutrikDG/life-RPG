/**
 * API BRIDGE: GITHUB PAGES -> GOOGLE SHEETS
 * Handles all network communication.
 */

const API_CONFIG = {
    URL: "https://script.google.com/macros/s/AKfycbyF7tzmP2a58IybRurOTtnn_flqzyb8oZQY32HI2mzTdJxjcfRl6ghnJBYzrou0I22tfQ/exec",
    TOKEN: ""
};

async function fetchData(action) {
    try {
        const url = `${API_CONFIG.URL}?action=${action}&_t=${Date.now()}`;
        const response = await fetch(url);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error(`Failed to fetch ${action}:`, error);
        return null;
    }
}

async function sendPost(payload) {
    try {
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

// --- PUBLIC API ---

async function fetchCategories() {
    const data = await fetchData("GET_CATEGORIES");
    return data ? data.categories : [];
}

async function fetchHabits() {
    const data = await fetchData("GET_HABITS");
    return data ? data.habits : [];
}

async function getStats() {
    const data = await fetchData("GET_STATS");
    return data ? data.stats : { category_stats: {}, habit_stats: {} };
}

async function saveCategory(categoryData) {
    return sendPost({ action: "SAVE_CATEGORY", ...categoryData });
}

async function saveHabit(habitData) {
    return sendPost({ action: "SAVE_HABIT", ...habitData });
}

async function postLog(data) {
    return sendPost({ action: "LOG", ...data });
}
