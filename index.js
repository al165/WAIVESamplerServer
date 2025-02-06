import express from 'express';
import session from 'express-session';
import multer from 'multer';
import path, { resolve } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const dbPromise = open({
    filename: 'data.db',
    driver: sqlite3.Database
});

const app = express();
const PORT = 3000;

let user_version;

import { config } from 'dotenv';
config({ path: './.env' });

// Middleware setup
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Session configuration
app.use(session({
    secret: 'secretkey',
    resave: false,
    saveUninitialized: false
}));

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const currentPath = path.join(__dirname, 'uploads', req.query.archive);
        if (!fs.existsSync(currentPath)) fs.mkdirSync(currentPath, { recursive: true });
        cb(null, currentPath);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage });

// Hardcoded login credentials
const USER = {
    username: process.env.USERNAME,
    password: process.env.PASSWORD
};

// Authentication Middleware
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

// Routes
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === USER.username && password === USER.password) {
        req.session.user = USER;
        res.redirect('/dashboard');
    } else {
        res.render('login', { error: 'Invalid credentials' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
    const db = await dbPromise;
    const archives = await db.all("SELECT * FROM Archives;", [], (err, rows) => {
        return rows;
    });

    console.log(archives);

    res.render('dashboard', { archives, user_version });
});

app.get('/dashboard/*', isAuthenticated, async (req, res) => {
    const archive = req.params[0];
    const currentPath = path.join(__dirname, 'uploads', archive);

    if (!fs.existsSync(currentPath)) {
        return res.redirect('/dashboard');
    }

    const db = await dbPromise;
    const sources = await db.all('SELECT * FROM Sources WHERE archive = ?', [archive]);

    res.render('archive', { files: sources, archive, user_version });
});

app.post('/upload', isAuthenticated, upload.array('file'), async (req, res) => {
    const archive = req.query.archive;
    const files = req.files;
    const db = await dbPromise;

    await db.run("BEGIN TRANSACTION");
    for (const file of files) {
        await db.run("INSERT INTO Sources(archive, filename) VALUES (?, ?)", [archive, file.originalname]);
    }
    await db.run("COMMIT");

    await updateVersion(db);
    res.redirect(`/dashboard/${archive}`);
});

app.post('/add-archive', isAuthenticated, async (req, res) => {
    const archiveName = req.body.archiveName;
    const folderPath = path.join(__dirname, 'uploads', archiveName);

    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath);
    }

    const db = await dbPromise;
    await db.run("INSERT OR IGNORE INTO Archives(name) VALUES (?)", [archiveName], (err) => {
        if (err)
            console.log(err);
    });
    await updateVersion(db);

    res.redirect(`/dashboard/${archiveName}`);
});

app.post('/update/*', isAuthenticated, async (req, res) => {
    const archive = req.params[0];
    const folderPath = path.join(__dirname, 'uploads', archive);

    console.log("/update for archive " + archive);

    if (!archive || !fs.existsSync(folderPath)) {
        res.redirect('/dashboard');
        return;
    }

    const { description, tags, license, checkboxState, id } = req.body;

    console.log("id: " + id);

    let queryString = "UPDATE Sources SET ";
    let columns = [];
    let params = [];

    let update = false;

    if (description) {
        columns.push("description = ?");
        params.push(description);
        update = true;
    }

    if (tags) {
        columns.push("tags = ?");
        params.push(tags);
        update = true;
    }

    if (license) {
        columns.push("license = ?");
        params.push(license);
        update = true;
    }

    if (checkboxState != "indeterminate") {
        columns.push("hidden = ?");
        params.push(checkboxState == "checked");
        update = true;
    }

    queryString += columns.join(', ');
    queryString += " WHERE archive = ?";
    params.push(archive);

    if (id !== undefined) {
        queryString += "AND id = ?";
        params.push(id);
    }

    console.log(queryString);

    if (update) {
        const db = await dbPromise;
        await db.run(queryString, params, (err) => console.log(err.message));
        await updateVersion(db);
    }

    res.redirect(`/dashboard/${archive}`);
});

// Start Server
const setup = async () => {
    const db = await dbPromise;
    await db.migrate();

    let result = await db.all("PRAGMA user_version", []);
    console.log("user_version: ");
    user_version = result[0].user_version;
    console.log(user_version);

    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

setup();

async function updateVersion(db) {
    console.log("updateVersion()");

    user_version = Math.floor(Date.now() / 1000);
    await db.run(`PRAGMA user_version = ${user_version}`, [], (err) => {
        console.log(err);
    });
}

async function getSourceList() {
    // Creates a CSV file with the headings
    // Archive, Name, [description], [tags]

    // Read top level folders as archive

    const uploadsPath = path.join(__dirname, "uploads");

    const db = await dbPromise;

    // Get directories inside 'uploads'
    let archives = fs.readdirSync(uploadsPath)
        .filter(dirent => fs.statSync(path.join(uploadsPath, dirent)).isDirectory());

    console.log("\nSource list:");
    archives.forEach((archive) => {
        const archivePath = path.join(uploadsPath, archive);

        // Get files inside each archive directory
        let files = fs.readdirSync(archivePath)
            .filter(dirent => {
                return !fs.statSync(path.join(archivePath, dirent)).isDirectory();
            });

        // Log the archive and its files
        files.forEach(file => {
            console.log(`${archive}, ${file}`);
        });
    });
    console.log("\n");
}
