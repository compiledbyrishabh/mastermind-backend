const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your frontend to communicate with this backend
app.use(cors());
app.use(express.json());

// In-memory store for active games (Secure, not visible to players)
const activeGames = new Map();

// Game configurations
const CONFIGS = {
    easy:   { len: 4, maxDigit: 7, tries: 6, time: 60 },
    medium: { len: 5, maxDigit: 8, tries: 6, time: 90 },
    hard:   { len: 6, maxDigit: 9, tries: 5, time: 120 },
    expert: { len: 7, maxDigit: 9, tries: 5, time: 150 }
};

// 1. START GAME API
app.post('/api/game/start', (req, res) => {
    const { difficulty = 'easy' } = req.body;
    const config = CONFIGS[difficulty] || CONFIGS.easy;

    // Generate secret code securely ON THE SERVER
    const secret = [];
    let sum = 0;
    let evens = 0;

    for (let i = 0; i < config.len; i++) {
        const d = Math.floor(Math.random() * (config.maxDigit + 1));
        secret.push(d);
        sum += d;
        if (d % 2 === 0) evens++;
    }

    const gameId = crypto.randomUUID();

    // Store game securely in server memory
    activeGames.set(gameId, {
        secret,
        config,
        attemptsLeft: config.tries,
        revealedPositions: {}
    });

    // Send back ONLY the public hints and the Session ID
    res.json({
        gameId,
        hints: { sum, evens }
    });
});

// 2. SUBMIT GUESS API (Wordle Logic)
app.post('/api/game/guess', (req, res) => {
    const { gameId, guess } = req.body;
    const session = activeGames.get(gameId);

    if (!session) return res.status(404).json({ error: 'Game session not found.' });

    const guessArr = String(guess).split('').map(Number);
    session.attemptsLeft--;

    const feedback = new Array(session.config.len).fill('fb-miss');
    const secretUnmatched = [];
    const guessUnmatched = [];
    let exactMatches = 0;

    // Pass 1: Exact matches
    for (let i = 0; i < session.config.len; i++) {
        if (guessArr[i] === session.secret[i]) {
            feedback[i] = 'fb-exact';
            exactMatches++;
        } else {
            guessUnmatched.push({ val: guessArr[i], index: i });
            secretUnmatched.push(session.secret[i]);
        }
    }

    // Pass 2: Near matches
    for (let i = 0; i < guessUnmatched.length; i++) {
        const item = guessUnmatched[i];
        const matchIdx = secretUnmatched.indexOf(item.val);
        if (matchIdx !== -1) {
            feedback[item.index] = 'fb-near';
            secretUnmatched.splice(matchIdx, 1);
        }
    }

    const won = exactMatches === session.config.len;
    
    // If the game ends, delete the secure session
    if (won || session.attemptsLeft <= 0) {
        activeGames.delete(gameId);
    }

    res.json({
        feedback,
        won,
        secretCode: (won || session.attemptsLeft <= 0) ? session.secret.join('') : null
    });
});

// 3. REVEAL POWER API
app.post('/api/game/power/reveal', (req, res) => {
    const { gameId } = req.body;
    const session = activeGames.get(gameId);

    if (!session) return res.status(404).json({ error: 'Session not found.' });

    const unrevealed = [];
    for (let i = 0; i < session.config.len; i++) {
        if (!(i in session.revealedPositions)) unrevealed.push(i);
    }

    if (unrevealed.length === 0) return res.status(400).json({ error: 'All revealed.' });

    const targetPos = unrevealed[Math.floor(Math.random() * unrevealed.length)];
    const digit = session.secret[targetPos];
    session.revealedPositions[targetPos] = digit;

    res.json({ position: targetPos, digit: digit });
});

app.listen(PORT, () => {
    console.log(`\n[+] SUCCESS! Mastermind Secure Server is running on port ${PORT}`);
    console.log(`[+] Waiting for game connections...\n`);
});