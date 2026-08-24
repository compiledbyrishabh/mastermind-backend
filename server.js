const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

app.use(cors());
app.use(express.json());

// Connect to MongoDB Atlas
mongoose.connect(MONGO_URI)
  .then(() => console.log('[+] Connected to MongoDB Atlas Database'))
  .catch(err => console.error('[-] Database connection error:', err));

// Player Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  tokens: { type: Number, default: 10 },
  streak: { type: Number, default: 0 },
  maxStreak: { type: Number, default: 0 },
  bestRun: {
    diff: { type: Number, default: 0 },
    diffName: { type: String, default: '' },
    time: { type: Number, default: 9999 },
    powers: { type: Number, default: 9999 }
  },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// In-Memory Active Game Sessions
const activeGames = new Map();

const CONFIGS = {
  easy:   { len: 4, maxDigit: 7, tries: 6, time: 60, diffVal: 1 },
  medium: { len: 5, maxDigit: 8, tries: 6, time: 90, diffVal: 2 },
  hard:   { len: 6, maxDigit: 9, tries: 5, time: 120, diffVal: 3 },
  expert: { len: 7, maxDigit: 9, tries: 5, time: 150, diffVal: 4 }
};

/* --- AUTHENTICATION ROUTES --- */

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, username, password } = req.body;
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    const existingUser = await User.findOne({ username: username.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already taken.' });
    }

    const user = new User({ name, username, password });
    await user.save();

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username.toLowerCase(), password });
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password.' });
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// Get User Profile / Refresh Stats
app.get('/api/user/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user data.' });
  }
});

/* --- GLOBAL LEADERBOARDS --- */

// Top Runs & Top Streaks
app.get('/api/leaderboards', async (req, res) => {
  try {
    const topStreaks = await User.find({ maxStreak: { $gt: 0 } })
      .sort({ maxStreak: -1 })
      .limit(15)
      .select('name username maxStreak');

    const topRuns = await User.find({ 'bestRun.diff': { $gt: 0 } })
      .sort({ 'bestRun.diff': -1, 'bestRun.time': 1, 'bestRun.powers': 1 })
      .limit(15)
      .select('name username bestRun');

    res.json({ topStreaks, topRuns });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load leaderboards.' });
  }
});

/* --- GAMEPLAY LOGIC --- */

// Start Game
app.post('/api/game/start', async (req, res) => {
  try {
    const { difficulty = 'easy', username } = req.body;
    const config = CONFIGS[difficulty] || CONFIGS.easy;

    const user = await User.findOne({ username: username.toLowerCase() });
    if (user) {
      user.tokens += 1; // Entry reward
      await user.save();
    }

    const secret = [];
    let sum = 0, evens = 0;
    for (let i = 0; i < config.len; i++) {
      const d = Math.floor(Math.random() * (config.maxDigit + 1));
      secret.push(d);
      sum += d;
      if (d % 2 === 0) evens++;
    }

    const gameId = crypto.randomUUID();
    activeGames.set(gameId, {
      username: username.toLowerCase(),
      secret,
      config,
      mode: difficulty,
      attemptsLeft: config.tries,
      powersUsed: 0,
      revealsUsed: 0,
      revealedPositions: {}
    });

    res.json({
      gameId,
      userTokens: user ? user.tokens : 0,
      hints: { sum, evens }
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not start session.' });
  }
});

// Guess Validation
app.post('/api/game/guess', async (req, res) => {
  try {
    const { gameId, guess } = req.body;
    const session = activeGames.get(gameId);
    if (!session) return res.status(404).json({ error: 'Game session expired.' });

    const guessArr = String(guess).split('').map(Number);
    session.attemptsLeft--;

    const feedback = new Array(session.config.len).fill('fb-miss');
    const secretUnmatched = [];
    const guessUnmatched = [];
    let exactMatches = 0;

    for (let i = 0; i < session.config.len; i++) {
      if (guessArr[i] === session.secret[i]) {
        feedback[i] = 'fb-exact';
        exactMatches++;
      } else {
        guessUnmatched.push({ val: guessArr[i], index: i });
        secretUnmatched.push(session.secret[i]);
      }
    }

    for (let i = 0; i < guessUnmatched.length; i++) {
      const item = guessUnmatched[i];
      const matchIdx = secretUnmatched.indexOf(item.val);
      if (matchIdx !== -1) {
        feedback[item.index] = 'fb-near';
        secretUnmatched.splice(matchIdx, 1);
      }
    }

    const won = exactMatches === session.config.len;
    const gameOver = won || session.attemptsLeft <= 0;

    res.json({
      feedback,
      won,
      gameOver,
      secretCode: gameOver ? session.secret.join('') : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Error validating guess.' });
  }
});

// Game Outcome Finalizer
app.post('/api/game/end', async (req, res) => {
  try {
    const { gameId, won, timeTaken } = req.body;
    const session = activeGames.get(gameId);
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    // Grab the secret code before deleting the session
    const secretCode = session.secret.join(''); 

    const user = await User.findOne({ username: session.username });
    let isNewBest = false;

    if (user) {
      if (won) {
        user.tokens += 3;
        user.streak += 1;
        if (user.streak > user.maxStreak) user.maxStreak = user.streak;

        const currentRun = {
          diff: session.config.diffVal,
          diffName: session.mode.toUpperCase(),
          time: timeTaken,
          powers: session.powersUsed
        };

        if (
          !user.bestRun.diff ||
          currentRun.diff > user.bestRun.diff ||
          (currentRun.diff === user.bestRun.diff && currentRun.time < user.bestRun.time) ||
          (currentRun.diff === user.bestRun.diff && currentRun.time === user.bestRun.time && currentRun.powers < user.bestRun.powers)
        ) {
          user.bestRun = currentRun;
          isNewBest = true;
        }
      } else {
        user.streak = 0;
      }
      await user.save();
    }

    activeGames.delete(gameId);
    // Send the secret code back to the frontend
    res.json({ success: true, user, isNewBest, secretCode });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user stats.' });
  }
});
// Reveal Power
app.post('/api/game/power/reveal', async (req, res) => {
  try {
    const { gameId } = req.body;
    const session = activeGames.get(gameId);
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    const user = await User.findOne({ username: session.username });
    if (!user || user.tokens < 20 || session.revealsUsed >= 2) {
      return res.status(400).json({ error: 'Insufficient tokens or reveal limit reached.' });
    }

    const unrevealed = [];
    for (let i = 0; i < session.config.len; i++) {
      if (!(i in session.revealedPositions)) unrevealed.push(i);
    }

    if (unrevealed.length === 0) return res.status(400).json({ error: 'All positions revealed.' });

    user.tokens -= 20;
    await user.save();

    session.powersUsed++;
    session.revealsUsed++;

    const targetPos = unrevealed[Math.floor(Math.random() * unrevealed.length)];
    const digit = session.secret[targetPos];
    session.revealedPositions[targetPos] = digit;

    res.json({
      position: targetPos,
      digit,
      revealsUsed: session.revealsUsed,
      userTokens: user.tokens
    });
  } catch (err) {
    res.status(500).json({ error: 'Error processing reveal power.' });
  }
});

// Time Power
app.post('/api/game/power/time', async (req, res) => {
  try {
    const { gameId } = req.body;
    const session = activeGames.get(gameId);
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    const user = await User.findOne({ username: session.username });
    if (!user || user.tokens < 5) {
      return res.status(400).json({ error: 'Insufficient tokens.' });
    }

    user.tokens -= 5;
    await user.save();
    session.powersUsed++;

    res.json({ success: true, userTokens: user.tokens });
  } catch (err) {
    res.status(500).json({ error: 'Error processing time power.' });
  }
});

app.listen(PORT, () => {
  console.log(`[+] Mastermind Central Server running on port ${PORT}`);
});
