const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    database: 'dnd_ability_lists',
    waitForConnections: true,
    connectionLimit: 10
});

module.exports = pool;