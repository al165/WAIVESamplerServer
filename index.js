import express from 'express';
import session from 'express-session';
import multer from 'multer';
import path, { resolve } from 'path';
import fs from 'fs';
import { stringify } from 'csv-stringify';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let dbPromise = open({
    filename: 'data.db',
    driver: sqlite3.Database
});

const app = express();
const PORT = 3000;

let user_version;
let undoSavePoints = [];

import { config } from 'dotenv';
config({ path: './.env' });

const CONFIG_DIR = process.env.CONFIG_DIR || 'uploads';
console.log("CONFIG_DIR: " + CONFIG_DIR);

// Middleware setup
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/file', express.static(CONFIG_DIR));
app.use('/js', express.static('js'));

// Session configuration
app.use(session({
    secret: 'secretkey',
    resave: false,
    saveUninitialized: false
}));

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const currentPath = path.join(__dirname, CONFIG_DIR, req.query.archive);
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

// GET Routes
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.get('/latest', (req, res) => {
    console.log("/latest");
    res.json({ version: user_version });
});

app.get('/filelist', async (req, res) => {
    console.log("/filelist");

    res.sendFile(path.join(__dirname, 'public', 'all_samples_data.tsv'));
});

app.get('/tags', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tags.tsv'));
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

    res.render('dashboard', { archives, user_version, undoSavePoints });
});

app.get('/dashboard/*', isAuthenticated, async (req, res) => {
    const archive = req.params[0];
    const currentPath = path.join(__dirname, CONFIG_DIR, archive);

    if (!fs.existsSync(currentPath)) {
        return res.redirect('/dashboard');
    }

    const db = await dbPromise;
    const sources = await db.all('SELECT * FROM Sources WHERE archive = ?', [archive]);

    res.render('archive', { files: sources, archive, user_version, undoSavePoints });
});

app.get('/undo', isAuthenticated, async (req, res) => {
    if (undoSavePoints.length == 0)
        res.redirect('/dashboard');

    let lastSp = undoSavePoints.pop();
    console.log(lastSp);

    fs.renameSync(path.join(__dirname, 'backups', lastSp), path.join(__dirname, 'data.db'));

    dbPromise = open({
        filename: 'data.db',
        driver: sqlite3.Database
    });
    const db = await dbPromise;

    let result = await db.all("PRAGMA user_version", []);
    user_version = result[0].user_version;

    res.sendStatus(200);
});

// POST Routes
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === USER.username && password === USER.password) {
        req.session.user = USER;
        res.redirect('/dashboard');
    } else {
        res.render('login', { error: 'Invalid credentials' });
    }
});

app.post('/upload', isAuthenticated, upload.array('file'), async (req, res) => {
    const archive = req.query.archive;
    const files = req.files;
    const db = await dbPromise;

    let count = 0;

    createSavePoint(db);
    await db.run("BEGIN TRANSACTION");
    for (const file of files) {
        // generate id
        const serverID = 1;
        const timestamp = Date.now() % 100000;
        // const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const id = parseInt(`${serverID}${timestamp}${count.toString().padStart(3, '0')}`);

        await db.run("INSERT INTO Sources(id, archive, filename) VALUES (?, ?, ?)", [id, archive, file.originalname]);

        count = (count + 1) % 1000;
    }
    await db.run("COMMIT");

    await updateVersion(db);
    res.redirect(`/dashboard/${archive}`);
});

app.post('/add-archive', isAuthenticated, async (req, res) => {
    const archiveName = removeWhitespaceExceptSpace(req.body.archiveName);
    const folderPath = path.join(__dirname, CONFIG_DIR, archiveName);

    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath);
    }

    const db = await dbPromise;
    createSavePoint(db);
    await db.run("INSERT OR IGNORE INTO Archives(name) VALUES (?)", [archiveName], (err) => {
        if (err)
            console.log(err);
    });
    await updateVersion(db);

    res.redirect(`/dashboard/${archiveName}`);
});

app.post('/update/*', isAuthenticated, async (req, res) => {
    const archive = req.params[0];
    const folderPath = path.join(__dirname, CONFIG_DIR, archive);

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
        params.push(removeWhitespaceExceptSpace(description));
        update = true;
    }

    if (tags) {
        columns.push("tags = ?");
        params.push(removeWhitespaceExceptSpace(tags));
        update = true;
    }

    if (license) {
        columns.push("license = ?");
        params.push(removeWhitespaceExceptSpace(license));
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
        createSavePoint(db)
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

    await createCSV();

    // get list of backups:
    console.log("Getting backups:");
    const backupDir = path.join(__dirname, 'backups/');
    console.log(backupDir);
    const backups = fs.readdirSync(backupDir);
    undoSavePoints = backups.map(fn => {
        let stat = fs.statSync(path.join(__dirname, 'backups', fn));

        return {
            name: fn,
            time: stat.mtime.getTime()
        }
    })
        .sort((a, b) => { return a.time - b.time })
        .map(v => v.name);
    console.log(undoSavePoints);

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

    await createCSV();
}

async function createCSV() {
    console.log("createCSV()");
    const writableStream = fs.createWriteStream(path.join(__dirname, 'public', 'all_samples_data.tsv'));

    const columns = [
        "id", "description", "tags", "folder", "filename", "archive", "url", "license"
    ];

    const stringifier = stringify({ header: true, columns: columns, delimiter: '\t' });

    const db = await dbPromise;
    db.each("SELECT * FROM Sources WHERE hidden != 1 OR hidden IS NULL;", (err, row) => {
        if (err) {
            console.log(err.message);
            return;
        }

        if (row.description == undefined) {
            row.description = row.filename;
        }

        row.url = `${row.archive}/${row.filename}`;

        stringifier.write(row);
    });

    stringifier.pipe(writableStream);

    console.log("finished writing CSV");
}

async function createSavePoint(db) {
    let sp = `sp${undoSavePoints.length}.db`;

    if (!fs.existsSync(path.join(__dirname, 'backups'))) {
        fs.mkdirSync(path.join(__dirname, 'backups'));
    }

    fs.copyFileSync(path.join(__dirname, 'data.db'), path.join(__dirname, 'backups', sp));

    undoSavePoints.push(sp);
    console.log(undoSavePoints);

    while (undoSavePoints.length > 10) {
        let oldSp = undoSavePoints.shift();

        if (fs.existsSync(path.join(__dirname, 'backups', oldSp))) {
            fs.rmSync(path.join(__dirname, 'backups', oldSp));
            console.log("removed old backup " + oldSp);
        }
    }
}

function removeWhitespaceExceptSpace(str) {
    /* 
    Matches all whitespace characters except regular space (" ").
    Includes:
        \t (tab), \n (newline), \r (carriage return), \f (form feed), \v (vertical tab).
        Unicode whitespaces like \u00A0 (non-breaking space), \u2000-\u200A (various spaces), etc.
    */
    return str.replace(/[\t\n\r\f\v\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g, '');
}