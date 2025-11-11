const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '../database.sqlite');
const db = new sqlite3.Database(DB_PATH);

// Инициализация таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS publications (
    file_id TEXT PRIMARY KEY,
    document_id TEXT,
    file_type TEXT,       -- "actual" OR "deleted"
    date_of_creation TEXT,
    status TEXT,          -- "pending" OR "fullfiled"
    mime_type TEXT
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT,     -- view, upload, delete
    ip TEXT,
    user_agent TEXT,
    file_id TEXT,
    ts TEXT
  )`);
});

module.exports = {
    db,
    run: (sql, params=[]) => new Promise((res, rej) => {
        db.run(sql, params, function(err){
            if(err) return rej(err);
            res(this);
        });
    }),
    get: (sql, params=[]) => new Promise((res, rej) => {
        db.get(sql, params, (err, row) => {
            if(err) return rej(err);
            res(row);
        });
    }),
    all: (sql, params=[]) => new Promise((res, rej) => {
        db.all(sql, params, (err, rows) => {
            if(err) return rej(err);
            res(rows);
        });
    })
};
