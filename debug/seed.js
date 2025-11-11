// Добавление записи в БД (файл только для тестов), для случаев,
// когда файл добавлен вручную в папку publications

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath);

const file_id = 'test-123';
const document_id = 'doc-001';
const mime_type = 'pdf';
const file_type = 'actual';
const status = 'fulfilled';
const date_of_creation = new Date().toISOString();

db.run(
    `INSERT INTO publications (document_id, file_id, file_type, date_of_creation, status, mime_type)
   VALUES (?, ?, ?, ?, ?, ?)`,
    [document_id, file_id, file_type, date_of_creation, status, mime_type],
    function (err) {
        if (err) {
            console.error('Ошибка при добавлении записи:', err.message);
        } else {
            console.log(`✅ Запись успешно добавлена (file_id=${file_id})`);
        }
        db.close();
    }
);
