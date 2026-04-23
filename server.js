const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const pool = require('./db');
const { requireAuth, checkUserAccess } = require('./middleware');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'dnd-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});


// ============ ГЛАВНАЯ ============
app.get('/', (req, res) => {
    res.render('pages/index', { title: 'Главная', user: req.session.this_user });
});

// ============ РЕГИСТРАЦИЯ ============
app.get('/registration', (req, res) => {
    res.render('pages/registration', { title: 'Регистрация', user: req.session.this_user });
});

app.post('/registration/check', async (req, res) => {
    const { username } = req.body;
    if (!username || username.trim() === '') {
        return res.send(`<script>alert('Имя не может быть пустым'); window.location.href='/registration';</script>`);
    }
    try {
        const [existing] = await pool.query('SELECT username FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.send(`<script>alert('Пользователь уже существует'); window.location.href='/registration';</script>`);
        }
        await pool.query('INSERT INTO users (username) VALUES (?)', [username]);
        req.session.this_user = username;
        res.redirect(`/lc/${username}`);
    } catch (error) {
        res.send(`<script>alert('Ошибка'); window.location.href='/registration';</script>`);
    }
});

// ============ ВХОД ============
app.get('/entranse', (req, res) => {
    res.render('pages/entranse', { title: 'Вход', user: req.session.this_user });
});

app.post('/entranse/check', async (req, res) => {
    const { username } = req.body;
    try {
        const [users] = await pool.query('SELECT username FROM users WHERE username = ?', [username]);
        if (users.length === 0) {
            return res.send(`<script>alert('Пользователь не найден'); window.location.href='/entranse';</script>`);
        }
        req.session.this_user = username;
        res.redirect(`/lc/${username}`);
    } catch (error) {
        res.send(`<script>alert('Ошибка'); window.location.href='/entranse';</script>`);
    }
});

app.get('/lc_exit', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/noneuser', (req, res) => {
    res.render('pages/noneuser', { title: 'Ошибка', user: req.session.this_user });
});

// ============ ЛИЧНЫЙ КАБИНЕТ ============
app.get('/lc/:username', requireAuth, checkUserAccess, async (req, res) => {
    const { username } = req.params;
    try {
        const [characters] = await pool.query(
            `SELECT c.*, camp.name as campaign_name 
             FROM characters c
             LEFT JOIN campaign camp ON c.campaign_id = camp.campaign_id
             WHERE c.player = ?
             ORDER BY c.level DESC, c.name`,
            [username]
        );
        const [campaigns] = await pool.query('SELECT * FROM campaign WHERE master = ? ORDER BY name', [username]);
        res.render('pages/lc', { title: `Личный кабинет - ${username}`, user: username, characters, campaigns });
    } catch (error) {
        res.status(500).send('Ошибка');
    }
});

// ============ КАМПАНИИ ============
app.post('/lc/newcampaign/:username', requireAuth, checkUserAccess, async (req, res) => {
    const { username } = req.params;
    const { name } = req.body;
    if (!name || name.trim() === '') {
        return res.send(`<script>alert('Введите название'); window.location.href='/lc/${username}';</script>`);
    }
    await pool.query('INSERT INTO campaign (name, master) VALUES (?, ?)', [name.trim(), username]);
    res.redirect(`/lc/${username}`);
});

app.post('/lc/delcampaign/:campaign_id', requireAuth, async (req, res) => {
    const { campaign_id } = req.params;
    await pool.query('DELETE FROM campaign WHERE campaign_id = ?', [campaign_id]);
    res.redirect(`/lc/${req.session.this_user}`);
});

app.get('/lc/campaign/:username/:campaign_id', requireAuth, checkUserAccess, async (req, res) => {
    const { username, campaign_id } = req.params;
    const [campaign] = await pool.query('SELECT * FROM campaign WHERE campaign_id = ?', [campaign_id]);
    const [characters] = await pool.query(
        `SELECT c.*, u.username as player_name FROM characters c
         JOIN users u ON c.player = u.username
         WHERE c.campaign_id = ? ORDER BY c.name`,
        [campaign_id]
    );
    res.render('pages/campaign', { title: campaign[0]?.name, user: username, campaign: campaign[0], characters });
});

// ============ ПЕРСОНАЖИ ============
app.get('/lc/newcharacter/:username', requireAuth, checkUserAccess, async (req, res) => {
    const { username } = req.params;
    const [classes] = await pool.query('SELECT class_name FROM class ORDER BY class_name');
    const [archetypes] = await pool.query('SELECT name, class FROM archetype ORDER BY class, name');
    // Только кампании где мастер = username ИЛИ личная кампания этого пользователя (name = username)
    const [campaigns] = await pool.query(
        'SELECT campaign_id, name, master FROM campaign WHERE master = ? OR (master IS NULL AND name = ?) ORDER BY master IS NULL DESC, name',
        [username, username]
    );
    res.render('pages/character-form', { 
        title: 'Создание персонажа', 
        user: username, 
        classes, 
        archetypes,
        campaigns, 
        character: null, 
        isEdit: false 
    });
});

app.post('/lc/newcharacter/form/:username', requireAuth, checkUserAccess, async (req, res) => {
    const { username } = req.params;
    const { name, campaign_id, level, class_ch, archetype, strength, dexterity, constitution, intelligence, wisdom, charism } = req.body;
    
    if (!name || name.trim() === '') {
        return res.send(`<script>alert('Введите имя'); window.location.href='/lc/newcharacter/${username}';</script>`);
    }
    
    let finalCampaignId = campaign_id;
    
    // Если выбрана "Без кампании" - создаем или находим личную кампанию
    if (!campaign_id || campaign_id === '') {
        // Ищем личную кампанию (имя = логин, мастер = NULL)
        let [personalCamp] = await pool.query(
            'SELECT campaign_id FROM campaign WHERE name = ? AND master IS NULL',
            [username]
        );
        
        if (personalCamp.length === 0) {
            // Создаем личную кампанию
            const [result] = await pool.query(
                'INSERT INTO campaign (name, master) VALUES (?, NULL)',
                [username]
            );
            finalCampaignId = result.insertId;
        } else {
            finalCampaignId = personalCamp[0].campaign_id;
        }
    }
    
    try {
        await pool.query(
            `INSERT INTO characters (name, campaign_id, player, class, archetype, level, strength, dexterity, constitution, intelligence, wisdom, charism)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name.trim(), finalCampaignId, username, class_ch, archetype || null, level || 1, strength || 10, dexterity || 10, constitution || 10, intelligence || 10, wisdom || 10, charism || 10]
        );
        res.redirect(`/lc/${username}`);
    } catch (error) {
        res.send(`<script>alert('Ошибка: ${error.message}'); window.location.href='/lc/newcharacter/${username}';</script>`);
    }
});

app.get('/lc/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    const [characters] = await pool.query(
        `SELECT * FROM characters WHERE player = ? AND campaign_id = ? AND name = ?`,
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    if (characters.length === 0) return res.status(404).send('Персонаж не найден');
    const character = characters[0];
    // Получаем информацию о классе (has_class_features)
    const [classInfo] = await pool.query(
        'SELECT has_class_features FROM class WHERE class_name = ?',
        [character.class]
    );
    const hasClassFeatures = classInfo.length > 0 ? classInfo[0].has_class_features : 0;
    // Получаем умения персонажа
    const [abilities] = await pool.query(`
        SELECT DISTINCT a.name, a.description, l.level 
        FROM ability a
        JOIN (
            SELECT ability, level FROM ability_class WHERE class = ?
            UNION
            SELECT ability, level FROM ability_archetype WHERE archetype = ?
        ) l ON a.name = l.ability
        WHERE l.level <= ?
        ORDER BY l.level ASC
    `, [character.class, character.archetype || '', character.level]);
    
    // Получаем заклинания персонажа
    const [spells] = await pool.query(`
        SELECT s.name, s.level, s.description, sl.readiness
        FROM spell s
        JOIN spellList sl ON s.name = sl.spell
        WHERE sl.player = ? AND sl.campaign_id = ? AND sl.character_name = ?
        ORDER BY s.level ASC
    `, [username, camp_id === 'null' ? null : camp_id, decodedName]);
    
    // Получаем воззвания (для колдуна и других)
    const [appeals] = await pool.query(`
        SELECT a.name, a.level, a.description
        FROM appeals a
        JOIN selected_appeal sa ON a.name = sa.appeal
        WHERE sa.player = ? AND sa.campaign_id = ? AND sa.character_name = ?
        ORDER BY a.level ASC
    `, [username, camp_id === 'null' ? null : camp_id, decodedName]);
    
    res.render('pages/character', { 
        title: character.name, 
        user: username, 
        character, 
        camp_id,
        hasClassFeatures,
        abilities,
        spells,
        appeals
    });
});

app.post('/lc/levelup/:lvl/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { lvl, username, camp_id, char_name } = req.params;
    await pool.query(`UPDATE characters SET level = ? WHERE player = ? AND campaign_id = ? AND name = ?`,
        [lvl, username, camp_id === 'null' ? null : camp_id, decodeURIComponent(char_name)]);
    res.redirect(`/lc/${username}/${camp_id}/${char_name}`);
});

app.get('/lc/delete/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    await pool.query(`DELETE FROM characters WHERE player = ? AND campaign_id = ? AND name = ?`,
        [username, camp_id === 'null' ? null : camp_id, decodeURIComponent(char_name)]);
    res.redirect(`/lc/${username}`);
});

app.get('/lc/character_change/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    
    const [characters] = await pool.query(
        'SELECT * FROM characters WHERE player = ? AND campaign_id = ? AND name = ?',
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    if (characters.length === 0) return res.status(404).send('Персонаж не найден');
    
    const [classes] = await pool.query('SELECT class_name FROM class ORDER BY class_name');
    const [archetypes] = await pool.query('SELECT name, class FROM archetype ORDER BY class, name');
    
    // Кампании для выбора:
    // 1. Личная кампания пользователя (master IS NULL AND name = username)
    // 2. Кампании где пользователь мастер
    // 3. Текущая кампания персонажа (если она не попадает в первые две)
    const [campaigns] = await pool.query(
        `SELECT campaign_id, name, master FROM campaign 
         WHERE master = ? OR (master IS NULL AND name = ?) OR campaign_id = ?
         ORDER BY master IS NULL DESC, name`,
        [username, username, camp_id === 'null' ? null : camp_id]
    );
    
    res.render('pages/character-form', {
        title: 'Редактирование персонажа',
        user: username,
        classes,
        archetypes,
        campaigns,
        character: characters[0],
        camp_id: camp_id === 'null' ? null : camp_id,
        isEdit: true
    });
});

app.post('/lc/character_changePost/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    const { name, level, class_ch, archetype, strength, dexterity, constitution, intelligence, wisdom, charism, campaign_id } = req.body;
    
    let finalCampaignId = campaign_id;
    
    // Если выбрана "Без кампании" - находим или создаем личную кампанию
    if (!campaign_id || campaign_id === '') {
        let [personalCamp] = await pool.query(
            'SELECT campaign_id FROM campaign WHERE name = ? AND master IS NULL',
            [username]
        );
        if (personalCamp.length === 0) {
            const [result] = await pool.query(
                'INSERT INTO campaign (name, master) VALUES (?, NULL)',
                [username]
            );
            finalCampaignId = result.insertId;
        } else {
            finalCampaignId = personalCamp[0].campaign_id;
        }
    }
    
    const newName = (name && name.trim()) ? name.trim() : decodedName;
    
    // Если имя меняется - нужно создать нового персонажа и скопировать данные
    if (newName !== decodedName) {
        // Проверяем, нет ли уже персонажа с новым именем
        const [existing] = await pool.query(
            'SELECT * FROM characters WHERE player = ? AND campaign_id = ? AND name = ?',
            [username, finalCampaignId, newName]
        );
        
        if (existing.length > 0) {
            return res.send(`<script>alert('Персонаж с именем "${newName}" уже существует в этой кампании'); window.history.back();</script>`);
        }
        
        // Создаем нового персонажа
        await pool.query(
            `INSERT INTO characters (name, campaign_id, player, class, archetype, level, 
              strength, dexterity, constitution, intelligence, wisdom, charism)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`,
            [newName, finalCampaignId, username, class_ch, archetype || null, level,
             strength, dexterity, constitution, intelligence, wisdom, charism]
        );
        
        // Копируем заклинания
        await pool.query(
            `INSERT INTO spellList (character_name, campaign_id, player, spell, readiness)
             SELECT ?, ?, ?, spell, readiness FROM spellList
             WHERE character_name = ? AND campaign_id = ? AND player = ?`,
            [newName, finalCampaignId, username, decodedName, camp_id === 'null' ? null : camp_id, username]
        );
        
        // Копируем воззвания
        await pool.query(
            `INSERT INTO selected_appeal (appeal, campaign_id, player, character_name)
             SELECT appeal, ?, ?, ? FROM selected_appeal
             WHERE character_name = ? AND campaign_id = ? AND player = ?`,
            [finalCampaignId, username, newName, decodedName, camp_id === 'null' ? null : camp_id, username]
        );
        
        // Копируем инвентарь
        await pool.query(
            `INSERT INTO character_items (player, campaign_id, character_name, item_name, quantity)
             SELECT ?, ?, ?, item_name, quantity FROM character_items
             WHERE player = ? AND campaign_id = ? AND character_name = ?`,
            [username, finalCampaignId, newName, username, camp_id === 'null' ? null : camp_id, decodedName]
        );
        
        // Удаляем старого персонажа
        await pool.query(
            'DELETE FROM characters WHERE player = ? AND campaign_id = ? AND name = ?',
            [username, camp_id === 'null' ? null : camp_id, decodedName]
        );
        
        res.redirect(`/lc/${username}/${finalCampaignId || 'null'}/${encodeURIComponent(newName)}`);
    } else {
        // Просто обновляем существующего
        await pool.query(
            `UPDATE characters SET 
                campaign_id = ?, class = ?, archetype = ?, level = ?, 
                strength = ?, dexterity = ?, constitution = ?, 
                intelligence = ?, wisdom = ?, charism = ?
             WHERE player = ? AND campaign_id = ? AND name = ?`,
            [finalCampaignId, class_ch, archetype || null, level,
             strength, dexterity, constitution, intelligence, wisdom, charism,
             username, camp_id === 'null' ? null : camp_id, decodedName]
        );
        
        // Если кампания изменилась - обновляем связанные данные
        if (finalCampaignId != (camp_id === 'null' ? null : camp_id)) {
            await pool.query(
                'UPDATE spellList SET campaign_id = ? WHERE player = ? AND campaign_id = ? AND character_name = ?',
                [finalCampaignId, username, camp_id === 'null' ? null : camp_id, decodedName]
            );
            await pool.query(
                'UPDATE selected_appeal SET campaign_id = ? WHERE player = ? AND campaign_id = ? AND character_name = ?',
                [finalCampaignId, username, camp_id === 'null' ? null : camp_id, decodedName]
            );
            await pool.query(
                'UPDATE character_items SET campaign_id = ? WHERE player = ? AND campaign_id = ? AND character_name = ?',
                [finalCampaignId, username, camp_id === 'null' ? null : camp_id, decodedName]
            );
        }
        
        res.redirect(`/lc/${username}/${finalCampaignId || 'null'}/${encodeURIComponent(decodedName)}`);
    }
});
// ============ УПРАВЛЕНИЕ ЗАКЛИНАНИЯМИ ПЕРСОНАЖА ============

// Страница добавления заклинаний (доступные по классу/архетипу)
app.get('/lc/fullSpellList/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    
    // Получаем персонажа
    const [characters] = await pool.query(
        'SELECT * FROM characters WHERE player = ? AND campaign_id = ? AND name = ?',
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    if (characters.length === 0) return res.status(404).send('Персонаж не найден');
    const character = characters[0];
    
    // Получаем уже изученные заклинания
    const [knownSpells] = await pool.query(
        'SELECT spell FROM spellList WHERE player = ? AND campaign_id = ? AND character_name = ?',
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    const knownSpellNames = knownSpells.map(s => s.spell);
    
    // Максимальный уровень заклинаний в зависимости от класса
    let maxSpellLevel = Math.floor(character.level / 2);
    if (character.class === 'Колдун') {
        maxSpellLevel = Math.min(Math.floor(character.level / 2), 5);
    } else if (character.class === 'Паладин' || character.class === 'Следопыт') {
        maxSpellLevel = Math.floor(character.level / 4);
    } else if (character.archetype === 'Мистический рыцарь') {
        maxSpellLevel = Math.floor((character.level - 2) / 4);
        if (maxSpellLevel < 0) maxSpellLevel = 0;
    }
    
    // Получаем доступные заклинания по классу/архетипу
    const [availableSpells] = await pool.query(`
        SELECT DISTINCT s.name, s.level, s.description, s.school
        FROM spell s
        WHERE s.level <= ? AND (
            s.name IN (SELECT spell FROM spell_class WHERE class = ?)
            OR s.name IN (SELECT spell FROM spell_archetype WHERE archetype = ?)
        )
        ORDER BY s.level ASC, s.name ASC
    `, [maxSpellLevel, character.class, character.archetype || '']);
    
    res.render('manage/spell-select', {
        title: 'Добавление заклинаний',
        user: username,
        character: character,
        camp_id: camp_id,
        spells: availableSpells,
        knownSpells: knownSpellNames,
        type: 'add'
    });
});

// Страница подготовки заклинаний
app.get('/lc/readySpellList/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    
    // Получаем персонажа
    const [characters] = await pool.query(
        'SELECT * FROM characters WHERE player = ? AND campaign_id = ? AND name = ?',
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    if (characters.length === 0) return res.status(404).send('Персонаж не найден');
    const character = characters[0];
    
    // Получаем все изученные заклинания с их статусом подготовки
    const [spells] = await pool.query(`
        SELECT s.name, s.level, s.description, sl.readiness
        FROM spell s
        JOIN spellList sl ON s.name = sl.spell
        WHERE sl.player = ? AND sl.campaign_id = ? AND sl.character_name = ?
        ORDER BY s.level ASC, s.name ASC
    `, [username, camp_id === 'null' ? null : camp_id, decodedName]);
    
    // Максимальное количество подготавливаемых заклинаний
    let maxPrepared = 0;
    if (character.class === 'Колдун') {
        maxPrepared = -1; // Колдуны не подготавливают
    } else if (character.class === 'Паладин' || character.class === 'Следопыт') {
        maxPrepared = Math.floor(character.level / 2) + character.charism > 10 ? Math.floor((character.charism - 10) / 2) : 0;
        if (maxPrepared < 0) maxPrepared = 0;
    } else {
        maxPrepared = character.level + (character.intelligence > 10 ? Math.floor((character.intelligence - 10) / 2) : 0);
        if (maxPrepared < 0) maxPrepared = character.level;
    }
    
    res.render('manage/spell-select', {
        title: 'Подготовка заклинаний',
        user: username,
        character: character,
        camp_id: camp_id,
        spells: spells,
        knownSpells: spells.map(s => s.name),
        maxPrepared: maxPrepared,
        type: 'ready'
    });
});

// Обработка добавления заклинаний
app.post('/lc/fullSpellListPost/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    const { spells: selectedSpells } = req.body;
    
    const spellsToAdd = Array.isArray(selectedSpells) ? selectedSpells : (selectedSpells ? [selectedSpells] : []);
    
    for (const spellName of spellsToAdd) {
        // Проверяем, не добавлено ли уже
        const [existing] = await pool.query(
            'SELECT * FROM spellList WHERE player = ? AND campaign_id = ? AND character_name = ? AND spell = ?',
            [username, camp_id === 'null' ? null : camp_id, decodedName, spellName]
        );
        
        if (existing.length === 0) {
            await pool.query(
                'INSERT INTO spellList (player, campaign_id, character_name, spell, readiness) VALUES (?, ?, ?, ?, 0)',
                [username, camp_id === 'null' ? null : camp_id, decodedName, spellName]
            );
        }
    }
    
    res.redirect(`/lc/${username}/${camp_id}/${encodeURIComponent(decodedName)}`);
});

// Обработка подготовки заклинаний
app.post('/lc/readyPostSpellList/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    const { spells: preparedSpells } = req.body;
    
    const preparedArray = Array.isArray(preparedSpells) ? preparedSpells : (preparedSpells ? [preparedSpells] : []);
    
    // Сначала сбрасываем все заклинания в неподготовленные
    await pool.query(
        'UPDATE spellList SET readiness = 0 WHERE player = ? AND campaign_id = ? AND character_name = ?',
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    
    // Затем отмечаем выбранные как подготовленные
    for (const spellName of preparedArray) {
        await pool.query(
            'UPDATE spellList SET readiness = 1 WHERE player = ? AND campaign_id = ? AND character_name = ? AND spell = ?',
            [username, camp_id === 'null' ? null : camp_id, decodedName, spellName]
        );
    }
    
    res.redirect(`/lc/${username}/${camp_id}/${encodeURIComponent(decodedName)}`);
});

// ============ УПРАВЛЕНИЕ ВОЗЗВАНИЯМИ ПЕРСОНАЖА ============

// Страница выбора классовых настроек (воззвания/инфузии)
app.get('/lc/fullAppealsList/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    
    const [characters] = await pool.query(
        'SELECT * FROM characters WHERE player = ? AND campaign_id = ? AND name = ?',
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    if (characters.length === 0) return res.status(404).send('Персонаж не найден');
    const character = characters[0];
    
    const [classInfo] = await pool.query(
        'SELECT has_class_features FROM class WHERE class_name = ?',
        [character.class]
    );
    const hasClassFeatures = classInfo.length > 0 ? classInfo[0].has_class_features : 0;
    
    if (!hasClassFeatures) {
        return res.send(`
            <script>
                alert('У класса "${character.class}" нет классовых настроек');
                window.location.href = '/lc/${username}/${camp_id}/${encodeURIComponent(decodedName)}';
            </script>
        `);
    }
    
    const [currentFeatures] = await pool.query(
        'SELECT appeal FROM selected_appeal WHERE player = ? AND campaign_id = ? AND character_name = ?',
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    const currentFeatureNames = currentFeatures.map(f => f.appeal);
    
    const maxFeatures = Math.max(1, Math.ceil(character.level / 2));
    
    // Получаем только те настройки, которые доступны по уровню персонажа
    const [availableFeatures] = await pool.query(
        'SELECT name, level, description FROM appeals WHERE class = ? AND level <= ? ORDER BY level ASC, name ASC',
        [character.class, character.level]
    );
    
    if (availableFeatures.length === 0) {
        return res.send(`
            <script>
                alert('Нет доступных классовых настроек для класса "${character.class}" на уровне ${character.level}.\\nСначала добавьте их в библиотеку.');
                window.location.href = '/manage/class-features/${encodeURIComponent(character.class)}';
            </script>
        `);
    }
    
    res.render('manage/class-features-select', {
        title: 'Выбор классовых настроек',
        user: username,
        character: character,
        camp_id: camp_id,
        features: availableFeatures,
        currentFeatures: currentFeatureNames,
        maxFeatures: maxFeatures
    });
});

// Обработка выбора классовых настроек
app.post('/lc/fullAppealsListPost/:username/:camp_id/:char_name', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    const { features: selectedFeatures } = req.body;
    
    const featuresArray = Array.isArray(selectedFeatures) ? selectedFeatures : (selectedFeatures ? [selectedFeatures] : []);
    
    // Удаляем старые настройки
    await pool.query(
        'DELETE FROM selected_appeal WHERE player = ? AND campaign_id = ? AND character_name = ?',
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    
    // Добавляем новые
    for (const featureName of featuresArray) {
        await pool.query(
            'INSERT INTO selected_appeal (player, campaign_id, character_name, appeal) VALUES (?, ?, ?, ?)',
            [username, camp_id === 'null' ? null : camp_id, decodedName, featureName]
        );
    }
    
    res.redirect(`/lc/${username}/${camp_id}/${encodeURIComponent(decodedName)}`);
});



// ============ ПРЕДМЕТЫ ============
// ============ ПРЕДМЕТЫ (CRUD) ============

// Список всех предметов
app.get('/manage/items', requireAuth, async (req, res) => {
    try {
        const [items] = await pool.query('SELECT * FROM items ORDER BY type, name');
        const types = ['Оружие', 'Доспех', 'Приключенческий', 'Магический', 'Чудесный', 'Расходный'];
        const rarities = ['Обычный', 'Необычный', 'Редкий', 'Очень редкий', 'Легендарный', 'Артефакт'];
        
        res.render('manage/items', {
            title: 'Управление предметами',
            user: req.session.this_user,
            items,
            types,
            rarities
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки предметов');
    }
});

// Форма создания предмета
app.get('/manage/items/new', requireAuth, (req, res) => {
    const types = ['Оружие', 'Доспех', 'Приключенческий', 'Магический', 'Чудесный', 'Расходный'];
    const rarities = ['Обычный', 'Необычный', 'Редкий', 'Очень редкий', 'Легендарный', 'Артефакт'];
    
    res.render('manage/item-form', {
        title: 'Новый предмет',
        user: req.session.this_user,
        item: null,
        types,
        rarities,
        isEdit: false
    });
});

// Создание предмета (без поля properties)
app.post('/manage/items', requireAuth, async (req, res) => {
    const { name, description, type, rarity, weight, cost, attunement } = req.body;
    
    if (!name || !name.trim()) {
        return res.send(`<script>alert('Введите название'); window.location.href='/manage/items/new';</script>`);
    }
    
    try {
        const [existing] = await pool.query('SELECT name FROM items WHERE name = ?', [name.trim()]);
        if (existing.length > 0) {
            return res.send(`<script>alert('Предмет уже существует'); window.location.href='/manage/items/new';</script>`);
        }
        
        await pool.query(
            `INSERT INTO items (name, description, type, rarity, weight, cost, attunement)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name.trim(), description || '', type || 'Приключенческий', rarity || 'Обычный', 
             parseFloat(weight) || 0, cost || '', attunement ? 1 : 0]
        );
        res.redirect('/manage/items');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.location.href='/manage/items/new';</script>`);
    }
});

// Форма редактирования предмета
app.get('/manage/items/edit/:name', requireAuth, async (req, res) => {
    try {
        const [items] = await pool.query('SELECT * FROM items WHERE name = ?', [decodeURIComponent(req.params.name)]);
        if (items.length === 0) return res.status(404).send('Предмет не найден');
        
        const types = ['Оружие', 'Доспех', 'Приключенческий', 'Магический', 'Чудесный', 'Расходный'];
        const rarities = ['Обычный', 'Необычный', 'Редкий', 'Очень редкий', 'Легендарный', 'Артефакт'];
        
        res.render('manage/item-form', {
            title: 'Редактирование предмета',
            user: req.session.this_user,
            item: items[0],
            types,
            rarities,
            isEdit: true
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки предмета');
    }
});

// Обновление предмета (без поля properties)
app.post('/manage/items/update/:old_name', requireAuth, async (req, res) => {
    const { old_name } = req.params;
    const { name, description, type, rarity, weight, cost, attunement } = req.body;
    
    try {
        await pool.query(
            `UPDATE items SET name=?, description=?, type=?, rarity=?, weight=?, cost=?, attunement=?
             WHERE name=?`,
            [name, description, type, rarity, parseFloat(weight) || 0, cost || '', attunement ? 1 : 0, old_name]
        );
        res.redirect('/manage/items');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.location.href='/manage/items/edit/${encodeURIComponent(old_name)}';</script>`);
    }
});

// Удаление предмета
app.post('/manage/items/delete/:name', requireAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM items WHERE name = ?', [decodeURIComponent(req.params.name)]);
        res.redirect('/manage/items');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// ============ ИНВЕНТАРЬ ПЕРСОНАЖА ============

// Просмотр инвентаря
app.get('/lc/:username/:camp_id/:char_name/inventory', requireAuth, checkUserAccess, async (req, res) => {
    const { username, camp_id, char_name } = req.params;
    const decodedName = decodeURIComponent(char_name);
    
    // Получаем персонажа
    const [characters] = await pool.query(
        'SELECT * FROM characters WHERE player = ? AND campaign_id = ? AND name = ?',
        [username, camp_id === 'null' ? null : camp_id, decodedName]
    );
    if (characters.length === 0) return res.status(404).send('Персонаж не найден');
    const character = characters[0];
    
    // Получаем инвентарь
    const [inventory] = await pool.query(`
        SELECT ci.*, i.type, i.rarity, i.weight, i.description, i.attunement, i.cost
        FROM character_items ci
        JOIN items i ON ci.item_name = i.name
        WHERE ci.player = ? AND ci.campaign_id = ? AND ci.character_name = ?
        ORDER BY i.type, i.name
    `, [username, camp_id === 'null' ? null : camp_id, decodedName]);
    
    // Получаем все доступные предметы для добавления
    const [allItems] = await pool.query('SELECT name, type, rarity FROM items ORDER BY type, name');
    
    // Группируем инвентарь по типам
    const inventoryByType = {};
    inventory.forEach(item => {
        if (!inventoryByType[item.type]) {
            inventoryByType[item.type] = [];
        }
        inventoryByType[item.type].push(item);
    });
    
    // Группируем доступные предметы по типам
    const itemsByType = {};
    allItems.forEach(item => {
        if (!itemsByType[item.type]) {
            itemsByType[item.type] = [];
        }
        itemsByType[item.type].push(item);
    });
    
    res.render('pages/inventory', {
        title: `Инвентарь - ${decodedName}`,
        user: username,
        character: character,
        camp_id: camp_id,
        inventory: inventory,
        inventoryByType: inventoryByType,
        allItems: allItems,
        itemsByType: itemsByType,
        totalWeight: inventory.reduce((sum, item) => sum + (item.weight * item.quantity), 0)
    });
});

// Добавление предмета в инвентарь
app.post('/lc/inventory/add', requireAuth, async (req, res) => {
    const { player, campaign_id, character_name, item_name, quantity } = req.body;
    const finalCampaignId = campaign_id === 'null' ? null : campaign_id;
    
    try {
        const [existing] = await pool.query(
            'SELECT * FROM character_items WHERE player = ? AND campaign_id = ? AND character_name = ? AND item_name = ?',
            [player, finalCampaignId, character_name, item_name]
        );
        
        if (existing.length > 0) {
            await pool.query(
                'UPDATE character_items SET quantity = quantity + ? WHERE player = ? AND campaign_id = ? AND character_name = ? AND item_name = ?',
                [parseInt(quantity) || 1, player, finalCampaignId, character_name, item_name]
            );
        } else {
            await pool.query(
                'INSERT INTO character_items (player, campaign_id, character_name, item_name, quantity) VALUES (?, ?, ?, ?, ?)',
                [player, finalCampaignId, character_name, item_name, parseInt(quantity) || 1]
            );
        }
        res.redirect(`/lc/${player}/${campaign_id || 'null'}/${encodeURIComponent(character_name)}/inventory`);
    } catch (error) {
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Удаление предмета из инвентаря
app.post('/lc/inventory/remove', requireAuth, async (req, res) => {
    const { player, campaign_id, character_name, item_name, quantity, remove_all } = req.body;
    const finalCampaignId = campaign_id === 'null' ? null : campaign_id;
    
    try {
        if (remove_all === 'on') {
            await pool.query(
                'DELETE FROM character_items WHERE player = ? AND campaign_id = ? AND character_name = ? AND item_name = ?',
                [player, finalCampaignId, character_name, item_name]
            );
        } else {
            const [current] = await pool.query(
                'SELECT quantity FROM character_items WHERE player = ? AND campaign_id = ? AND character_name = ? AND item_name = ?',
                [player, finalCampaignId, character_name, item_name]
            );
            
            const removeQty = parseInt(quantity) || 1;
            if (current.length > 0 && current[0].quantity > removeQty) {
                await pool.query(
                    'UPDATE character_items SET quantity = quantity - ? WHERE player = ? AND campaign_id = ? AND character_name = ? AND item_name = ?',
                    [removeQty, player, finalCampaignId, character_name, item_name]
                );
            } else {
                await pool.query(
                    'DELETE FROM character_items WHERE player = ? AND campaign_id = ? AND character_name = ? AND item_name = ?',
                    [player, finalCampaignId, character_name, item_name]
                );
            }
        }
        res.redirect(`/lc/${player}/${campaign_id || 'null'}/${encodeURIComponent(character_name)}/inventory`);
    } catch (error) {
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// ============ КЛАССЫ И АРХЕТИПЫ ============

// Список всех классов
app.get('/classes', async (req, res) => {
    const [classes] = await pool.query(`
        SELECT DISTINCT c.class_name, 
               (SELECT COUNT(*) FROM archetype WHERE class = c.class_name) as archetype_count,
               (SELECT COUNT(*) FROM ability_class WHERE class = c.class_name) as ability_count,
               (SELECT COUNT(*) FROM spell_class WHERE class = c.class_name) as spell_count
        FROM class c
        ORDER BY c.class_name
    `);
    
    res.render('pages/classes', {
        title: 'Классы D&D',
        user: req.session.this_user,
        classes: classes
    });
});

// Просмотр конкретного класса
// В маршруте /classes/:className
app.get('/classes/:className', async (req, res) => {
    const { className } = req.params;
    const decodedClass = decodeURIComponent(className);
    
    // Информация о классе - меняем имя переменной
    const [classInfo] = await pool.query(
        'SELECT * FROM class WHERE class_name = ?',
        [decodedClass]
    );
    if (classInfo.length === 0) return res.status(404).send('Класс не найден');
    
    // Архетипы класса
    const [archetypes] = await pool.query(
        'SELECT * FROM archetype WHERE class = ? ORDER BY name',
        [decodedClass]
    );
    
    // Умения класса по уровням
    const [abilities] = await pool.query(`
        SELECT a.name, a.description, ac.level
        FROM ability a
        JOIN ability_class ac ON a.name = ac.ability
        WHERE ac.class = ?
        ORDER BY ac.level ASC, a.name ASC
    `, [decodedClass]);
    
    // Заклинания класса по уровням
    const [spells] = await pool.query(`
        SELECT s.name, s.level, s.description, s.school
        FROM spell s
        JOIN spell_class sc ON s.name = sc.spell
        WHERE sc.class = ?
        ORDER BY s.level ASC, s.name ASC
    `, [decodedClass]);
    
    // Группируем заклинания по уровням
    const spellsByLevel = {};
    for (let i = 0; i <= 9; i++) {
        spellsByLevel[i] = spells.filter(s => s.level == i);
    }
    
    // Группируем умения по уровням
    const abilitiesByLevel = {};
    abilities.forEach(ability => {
        if (!abilitiesByLevel[ability.level]) {
            abilitiesByLevel[ability.level] = [];
        }
        abilitiesByLevel[ability.level].push(ability);
    });
    
    res.render('pages/class-detail', {
        title: `${decodedClass} - класс D&D`,
        user: req.session.this_user,
        classInfo: classInfo[0],  // ← переименовано
        archetypes: archetypes,
        abilitiesByLevel: abilitiesByLevel,
        spellsByLevel: spellsByLevel,
        maxLevel: 20
    });
});

// Просмотр конкретного архетипа
app.get('/archetype/:className/:archetypeName', async (req, res) => {
    const { className, archetypeName } = req.params;
    const decodedClass = decodeURIComponent(className);
    const decodedArchetype = decodeURIComponent(archetypeName);
    
    // Информация об архетипе
    const [archetypeInfo] = await pool.query(
        'SELECT * FROM archetype WHERE class = ? AND name = ?',
        [decodedClass, decodedArchetype]
    );
    if (archetypeInfo.length === 0) return res.status(404).send('Архетип не найден');
    
    // Умения архетипа
    const [abilities] = await pool.query(`
        SELECT a.name, a.description, aa.level
        FROM ability a
        JOIN ability_archetype aa ON a.name = aa.ability
        WHERE aa.archetype = ?
        ORDER BY aa.level ASC, a.name ASC
    `, [decodedArchetype]);
    
    // Заклинания архетипа
    const [spells] = await pool.query(`
        SELECT s.name, s.level, s.description, s.school
        FROM spell s
        JOIN spell_archetype sa ON s.name = sa.spell
        WHERE sa.archetype = ?
        ORDER BY s.level ASC, s.name ASC
    `, [decodedArchetype]);
    
    // Группируем
    const spellsByLevel = {};
    for (let i = 0; i <= 9; i++) {
        spellsByLevel[i] = spells.filter(s => s.level == i);
    }
    
    const abilitiesByLevel = {};
    abilities.forEach(ability => {
        if (!abilitiesByLevel[ability.level]) {
            abilitiesByLevel[ability.level] = [];
        }
        abilitiesByLevel[ability.level].push(ability);
    });
    
    res.render('pages/archetype-detail', {
        title: `${decodedArchetype} - архетип ${decodedClass}`,
        user: req.session.this_user,
        archetype: archetypeInfo[0],
        className: decodedClass,
        abilitiesByLevel: abilitiesByLevel,
        spellsByLevel: spellsByLevel
    });
});


// ============ ПОИСК ЗАКЛИНАНИЙ ============
app.get('/search', async (req, res) => {
    const { q, level, school, class: className, archetype } = req.query;
    
    try {
        let query = 'SELECT DISTINCT s.* FROM spell s';
        const params = [];
        const conditions = [];
        
        // Поиск по названию
        if (q && q.trim()) {
            conditions.push('s.name LIKE ?');
            params.push(`%${q}%`);
        }
        
        // Фильтр по уровню
        if (level && level !== '') {
            conditions.push('s.level = ?');
            params.push(parseInt(level));
        }
        
        // Фильтр по школе
        if (school && school !== '') {
            conditions.push('s.school = ?');
            params.push(school);
        }
        
        // Фильтр по классу И/ИЛИ архетипу
        if (className && className !== '' && archetype && archetype !== '') {
            // Если выбраны и класс, и архетип - показываем заклинания, доступные ИЛИ классу, ИЛИ архетипу
            query += ' LEFT JOIN spell_class sc ON s.name = sc.spell';
            query += ' LEFT JOIN spell_archetype sa ON s.name = sa.spell';
            conditions.push('(sc.class = ? OR sa.archetype = ?)');
            params.push(className, archetype);
        } else if (className && className !== '') {
            // Только класс
            query += ' JOIN spell_class sc ON s.name = sc.spell';
            conditions.push('sc.class = ?');
            params.push(className);
        } else if (archetype && archetype !== '') {
            // Только архетип
            query += ' JOIN spell_archetype sa ON s.name = sa.spell';
            conditions.push('sa.archetype = ?');
            params.push(archetype);
        }
        
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        query += ' ORDER BY s.level ASC, s.name ASC';
        
        const [spells] = await pool.query(query, params);
        
        // Получаем список классов для фильтра
        const [classes] = await pool.query('SELECT class_name FROM class ORDER BY class_name');
        
        // Получаем список архетипов для фильтра
        const [archetypes] = await pool.query('SELECT name, class FROM archetype ORDER BY class, name');
        
        res.render('pages/search', {
            title: 'Поиск заклинаний',
            user: req.session.this_user,
            spells,
            query: q || '',
            level: level || '',
            school: school || '',
            selectedClass: className || '',
            archetype: archetype || '',
            classes,
            archetypes
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка поиска');
    }
});

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============
function charModifier(val) {
    return Math.floor((val - 10) / 2);
}
app.locals.charModifier = charModifier;

function parseSpellDescription(description) {
    if (!description) return { meta: {}, cleanText: '' };
    
    const meta = {};
    let cleanText = description;
    
    // Вытаскиваем время накладывания
    const castingMatch = description.match(/Время накладывания:\s*([^\n]+)/i);
    if (castingMatch) {
        meta.casting_time = castingMatch[1].trim();
        cleanText = cleanText.replace(castingMatch[0], '');
    }
    
    // Вытаскиваем дистанцию
    const rangeMatch = description.match(/Дистанция:\s*([^\n]+)/i);
    if (rangeMatch) {
        meta.range = rangeMatch[1].trim();
        cleanText = cleanText.replace(rangeMatch[0], '');
    }
    
    // Вытаскиваем компоненты
    const componentsMatch = description.match(/Компоненты:\s*([^\n]+)/i);
    if (componentsMatch) {
        meta.components = componentsMatch[1].trim();
        cleanText = cleanText.replace(componentsMatch[0], '');
    }
    
    // Вытаскиваем длительность
    const durationMatch = description.match(/Длительность:\s*([^\n]+)/i);
    if (durationMatch) {
        meta.duration = durationMatch[1].trim();
        cleanText = cleanText.replace(durationMatch[0], '');
    }
    
    // Вытаскиваем источники (сохраняем все через запятую)
    const sourceMatch = description.match(/Источники?:\s*([^\n]+)/i);
    if (sourceMatch) {
        meta.sources = sourceMatch[1].trim();
        cleanText = cleanText.replace(sourceMatch[0], '');
    }
    
    // Очищаем текст от лишних переносов
    cleanText = cleanText.trim();
    
    return { meta, cleanText };
}
app.locals.parseSpellDescription = parseSpellDescription;



// ============ УПРАВЛЕНИЕ ЗАКЛИНАНИЯМИ ============

// Список всех заклинаний с поиском
app.get('/manage/spells', requireAuth, async (req, res) => {
    try {
        const { search, level, school } = req.query;
        let query = 'SELECT * FROM spell WHERE 1=1';
        const params = [];
        
        if (search && search.trim()) {
            query += ' AND name LIKE ?';
            params.push(`%${search}%`);
        }
        if (level && level !== '') {
            query += ' AND level = ?';
            params.push(parseInt(level));
        }
        if (school && school !== '') {
            query += ' AND school = ?';
            params.push(school);
        }
        
        query += ' ORDER BY level ASC, name ASC';
        
        const [spells] = await pool.query(query, params);
        const schools = ['Ограждение', 'Воплощение', 'Вызов', 'Иллюзия', 'Некромантия', 'Очарование', 'Преобразование', 'Прорицание'];
        
        res.render('manage/spells', {
            title: 'Управление заклинаниями',
            user: req.session.this_user,
            spells,
            schools,
            search: search || '',
            level: level || '',
            school: school || ''
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки заклинаний');
    }
});

// Форма создания заклинания
app.get('/manage/spells/new', requireAuth, async (req, res) => {
    try {
        const schools = ['Ограждение', 'Воплощение', 'Вызов', 'Иллюзия', 'Некромантия', 'Очарование', 'Преобразование', 'Прорицание'];
        
        // Получаем все классы из БД
        const [classes] = await pool.query('SELECT class_name FROM class ORDER BY class_name');
        
        // Получаем все архетипы из БД
        const [archetypes] = await pool.query('SELECT name, class FROM archetype ORDER BY class, name');
        
        res.render('manage/spell-form', {
            title: 'Новое заклинание',
            user: req.session.this_user,
            spell: null,
            schools,
            classes,
            archetypes,
            isEdit: false
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки формы');
    }
});
// Создание заклинания 
app.post('/manage/spells', requireAuth, async (req, res) => {
    const { name, school, level, range_spell, description, classes, archetypes } = req.body;
    
    if (!name || !name.trim()) {
        return res.send(`<script>alert('Введите название'); window.location.href='/manage/spells/new';</script>`);
    }
    
    try {
        const [existing] = await pool.query('SELECT name FROM spell WHERE name = ?', [name.trim()]);
        if (existing.length > 0) {
            return res.send(`<script>alert('Заклинание уже существует'); window.location.href='/manage/spells/new';</script>`);
        }
        
        // Создаем заклинание
        await pool.query(
            `INSERT INTO spell (name, school, level, range_spell, description)
             VALUES (?, ?, ?, ?, ?)`,
            [name.trim(), school, parseInt(level) || 0, parseInt(range_spell) || 0, description || '']
        );
        
        // Добавляем привязки к классам
        const classArray = Array.isArray(classes) ? classes : (classes ? [classes] : []);
        for (const className of classArray) {
            await pool.query(
                'INSERT INTO spell_class (spell, class) VALUES (?, ?)',
                [name.trim(), className]
            );
        }
        
        // Добавляем привязки к архетипам
        const archetypeArray = Array.isArray(archetypes) ? archetypes : (archetypes ? [archetypes] : []);
        for (const archetypeName of archetypeArray) {
            await pool.query(
                'INSERT INTO spell_archetype (spell, archetype) VALUES (?, ?)',
                [name.trim(), archetypeName]
            );
        }
        
        res.redirect('/manage/spells');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.location.href='/manage/spells/new';</script>`);
    }
});

// Обновление заклинания (с привязками)
app.post('/manage/spells/update/:old_name', requireAuth, async (req, res) => {
    const { old_name } = req.params;
    const { name, school, level, range_spell, description, classes, archetypes } = req.body;
    
    try {
        // Обновляем заклинание
        await pool.query(
            `UPDATE spell SET name=?, school=?, level=?, range_spell=?, description=?
             WHERE name=?`,
            [name, school, parseInt(level) || 0, parseInt(range_spell) || 0, description || '', old_name]
        );
        
        // Обновляем привязки к классам
        await pool.query('DELETE FROM spell_class WHERE spell = ?', [old_name]);
        const classArray = Array.isArray(classes) ? classes : (classes ? [classes] : []);
        for (const className of classArray) {
            await pool.query(
                'INSERT INTO spell_class (spell, class) VALUES (?, ?)',
                [name, className]
            );
        }
        
        // Обновляем привязки к архетипам
        await pool.query('DELETE FROM spell_archetype WHERE spell = ?', [old_name]);
        const archetypeArray = Array.isArray(archetypes) ? archetypes : (archetypes ? [archetypes] : []);
        for (const archetypeName of archetypeArray) {
            await pool.query(
                'INSERT INTO spell_archetype (spell, archetype) VALUES (?, ?)',
                [name, archetypeName]
            );
        }
        
        res.redirect('/manage/spells');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.location.href='/manage/spells/edit/${encodeURIComponent(old_name)}';</script>`);
    }
});

// Форма редактирования заклинания
app.get('/manage/spells/edit/:name', requireAuth, async (req, res) => {
    try {
        const [spells] = await pool.query('SELECT * FROM spell WHERE name = ?', [decodeURIComponent(req.params.name)]);
        if (spells.length === 0) return res.status(404).send('Заклинание не найдено');
        
        const schools = ['Ограждение', 'Воплощение', 'Вызов', 'Иллюзия', 'Некромантия', 'Очарование', 'Преобразование', 'Прорицание'];
        
        // Получаем все классы из БД
        const [classes] = await pool.query('SELECT class_name FROM class ORDER BY class_name');
        
        // Получаем все архетипы из БД
        const [archetypes] = await pool.query('SELECT name, class FROM archetype ORDER BY class, name');
        
        // Получаем уже привязанные классы для этого заклинания
        const [spellClasses] = await pool.query('SELECT class FROM spell_class WHERE spell = ?', [spells[0].name]);
        const boundClasses = spellClasses.map(sc => sc.class);
        
        // Получаем уже привязанные архетипы для этого заклинания
        const [spellArchetypes] = await pool.query('SELECT archetype FROM spell_archetype WHERE spell = ?', [spells[0].name]);
        const boundArchetypes = spellArchetypes.map(sa => sa.archetype);
        
        res.render('manage/spell-form', {
            title: 'Редактирование заклинания',
            user: req.session.this_user,
            spell: spells[0],
            schools,
            classes,
            archetypes,
            boundClasses,
            boundArchetypes,
            isEdit: true
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки заклинания');
    }
});

// Обновление заклинания
app.post('/manage/spells/update/:old_name', requireAuth, async (req, res) => {
    const { old_name } = req.params;
    const { name, school, level, range_spell, description } = req.body;
    
    try {
        await pool.query(
            `UPDATE spell SET name=?, school=?, level=?, range_spell=?, description=?
             WHERE name=?`,
            [name, school, parseInt(level) || 0, parseInt(range_spell) || 0, description || '', old_name]
        );
        res.redirect('/manage/spells');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.location.href='/manage/spells/edit/${encodeURIComponent(old_name)}';</script>`);
    }
});

// Удаление заклинания
app.post('/manage/spells/delete/:name', requireAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM spell WHERE name = ?', [decodeURIComponent(req.params.name)]);
        res.redirect('/manage/spells');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});
// ============ ПРИВЯЗКА ЗАКЛИНАНИЙ К КЛАССАМ И АРХЕТИПАМ ============

// Страница управления привязками заклинаний
app.get('/manage/spell-links', requireAuth, async (req, res) => {
    try {
        // Получаем все заклинания
        const [spells] = await pool.query('SELECT name, level FROM spell ORDER BY level, name');
        
        // Получаем все классы
        const [classes] = await pool.query('SELECT class_name FROM class ORDER BY class_name');
        
        // Получаем все архетипы с их классами
        const [archetypes] = await pool.query('SELECT name, class FROM archetype ORDER BY class, name');
        
        // Получаем существующие привязки заклинаний к классам
        const [spellClasses] = await pool.query(`
            SELECT sc.spell, sc.class, s.level as spell_level 
            FROM spell_class sc
            JOIN spell s ON sc.spell = s.name
            ORDER BY s.level, sc.class, sc.spell
        `);
        
        // Получаем существующие привязки заклинаний к архетипам
        const [spellArchetypes] = await pool.query(`
            SELECT sa.spell, sa.archetype, a.class, s.level as spell_level
            FROM spell_archetype sa
            JOIN spell s ON sa.spell = s.name
            JOIN archetype a ON sa.archetype = a.name
            ORDER BY s.level, a.class, sa.archetype, sa.spell
        `);
        
        res.render('manage/spell-links', {
            title: 'Привязка заклинаний',
            user: req.session.this_user,
            spells,
            classes,
            archetypes,
            spellClasses,
            spellArchetypes
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки');
    }
});

// Добавление привязки заклинания к классу
app.post('/manage/spell-links/add-class', requireAuth, async (req, res) => {
    const { spell, class_name } = req.body;
    
    if (!spell || !class_name) {
        return res.send(`<script>alert('Выберите заклинание и класс'); window.history.back();</script>`);
    }
    
    try {
        // Проверяем, нет ли уже такой привязки
        const [existing] = await pool.query(
            'SELECT * FROM spell_class WHERE spell = ? AND class = ?',
            [spell, class_name]
        );
        
        if (existing.length > 0) {
            return res.send(`<script>alert('Такая привязка уже существует'); window.history.back();</script>`);
        }
        
        await pool.query(
            'INSERT INTO spell_class (spell, class) VALUES (?, ?)',
            [spell, class_name]
        );
        res.redirect('/manage/spell-links');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Удаление привязки заклинания к классу
app.post('/manage/spell-links/remove-class', requireAuth, async (req, res) => {
    const { spell, class_name } = req.body;
    
    try {
        await pool.query(
            'DELETE FROM spell_class WHERE spell = ? AND class = ?',
            [spell, class_name]
        );
        res.redirect('/manage/spell-links');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Добавление привязки заклинания к архетипу
app.post('/manage/spell-links/add-archetype', requireAuth, async (req, res) => {
    const { spell, archetype } = req.body;
    
    if (!spell || !archetype) {
        return res.send(`<script>alert('Выберите заклинание и архетип'); window.history.back();</script>`);
    }
    
    try {
        // Проверяем, нет ли уже такой привязки
        const [existing] = await pool.query(
            'SELECT * FROM spell_archetype WHERE spell = ? AND archetype = ?',
            [spell, archetype]
        );
        
        if (existing.length > 0) {
            return res.send(`<script>alert('Такая привязка уже существует'); window.history.back();</script>`);
        }
        
        await pool.query(
            'INSERT INTO spell_archetype (spell, archetype) VALUES (?, ?)',
            [spell, archetype]
        );
        res.redirect('/manage/spell-links');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Удаление привязки заклинания к архетипу
app.post('/manage/spell-links/remove-archetype', requireAuth, async (req, res) => {
    const { spell, archetype } = req.body;
    
    try {
        await pool.query(
            'DELETE FROM spell_archetype WHERE spell = ? AND archetype = ?',
            [spell, archetype]
        );
        res.redirect('/manage/spell-links');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// ============ УПРАВЛЕНИЕ КЛАССАМИ ============

// Страница управления классами
app.get('/manage/classes', requireAuth, async (req, res) => {
    try {
        const [classes] = await pool.query(`
            SELECT c.*, 
                   (SELECT COUNT(*) FROM archetype WHERE class = c.class_name) as archetype_count,
                   (SELECT COUNT(*) FROM ability_class WHERE class = c.class_name) as ability_count
            FROM class c
            ORDER BY c.class_name
        `);
        
        res.render('manage/classes', {
            title: 'Управление классами',
            user: req.session.this_user,
            classes
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки классов');
    }
});

// Создание нового класса
app.post('/manage/classes/new', requireAuth, async (req, res) => {
    const { class_name, has_class_features } = req.body;
    
    if (!class_name || !class_name.trim()) {
        return res.send(`<script>alert('Введите название класса'); window.history.back();</script>`);
    }
    
    try {
        await pool.query(
            `INSERT INTO class (class_name, has_class_features) VALUES (?, ?)`,
            [class_name.trim(), has_class_features ? 1 : 0]
        );
        res.redirect('/manage/classes');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Редактирование класса (только has_class_features)
app.post('/manage/classes/edit/:class_name', requireAuth, async (req, res) => {
    const { class_name } = req.params;
    const { has_class_features } = req.body;
    
    try {
        await pool.query(
            `UPDATE class SET has_class_features = ? WHERE class_name = ?`,
            [has_class_features ? 1 : 0, class_name]
        );
        res.redirect('/manage/classes');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Удаление класса
app.post('/manage/classes/delete/:class_name', requireAuth, async (req, res) => {
    const { class_name } = req.params;
    
    try {
        await pool.query('DELETE FROM class WHERE class_name = ?', [class_name]);
        res.redirect('/manage/classes');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// ============ УПРАВЛЕНИЕ АРХЕТИПАМИ ============

// Страница управления архетипами
app.get('/manage/archetypes/:className', requireAuth, async (req, res) => {
    const { className } = req.params;
    const decodedClass = decodeURIComponent(className);
    
    try {
        const [classInfo] = await pool.query('SELECT * FROM class WHERE class_name = ?', [decodedClass]);
        if (classInfo.length === 0) return res.status(404).send('Класс не найден');
        
        const [archetypes] = await pool.query('SELECT * FROM archetype WHERE class = ? ORDER BY name', [decodedClass]);
        
        res.render('manage/archetypes', {
            title: `Архетипы класса ${decodedClass}`,
            user: req.session.this_user,
            className: decodedClass,
            classInfo: classInfo[0],
            archetypes
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки архетипов');
    }
});

// Создание архетипа
app.post('/manage/archetypes/new', requireAuth, async (req, res) => {
    const { class_name, name } = req.body;
    
    if (!name || !name.trim()) {
        return res.send(`<script>alert('Введите название архетипа'); window.history.back();</script>`);
    }
    
    try {
        await pool.query(
            'INSERT INTO archetype (class, name) VALUES (?, ?)',
            [class_name, name.trim()]
        );
        res.redirect(`/manage/archetypes/${encodeURIComponent(class_name)}`);
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Редактирование архетипа
app.post('/manage/archetypes/edit', requireAuth, async (req, res) => {
    const { old_name, class_name, name } = req.body;
    
    try {
        await pool.query(
            'UPDATE archetype SET name = ? WHERE class = ? AND name = ?',
            [name, class_name, old_name]
        );
        res.redirect(`/manage/archetypes/${encodeURIComponent(class_name)}`);
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Удаление архетипа
app.post('/manage/archetypes/delete', requireAuth, async (req, res) => {
    const { class_name, name } = req.body;
    
    try {
        await pool.query('DELETE FROM archetype WHERE class = ? AND name = ?', [class_name, name]);
        res.redirect(`/manage/archetypes/${encodeURIComponent(class_name)}`);
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});





// ============ УПРАВЛЕНИЕ СПОСОБНОСТЯМИ (ОБЩЕЕ) ============

// Страница управления способностями (библиотека)
app.get('/manage/abilities', requireAuth, async (req, res) => {
    try {
        const { search } = req.query;
        let query = 'SELECT * FROM ability';
        const params = [];
        
        if (search && search.trim()) {
            query += ' WHERE name LIKE ?';
            params.push(`%${search}%`);
        }
        query += ' ORDER BY name';
        
        const [abilities] = await pool.query(query, params);
        
        // Для каждой способности получаем список классов и архетипов
        for (let ability of abilities) {
            const [classes] = await pool.query(
                'SELECT class, level FROM ability_class WHERE ability = ? ORDER BY level, class',
                [ability.name]
            );
            const [archetypes] = await pool.query(
                'SELECT archetype, level FROM ability_archetype WHERE ability = ? ORDER BY level, archetype',
                [ability.name]
            );
            ability.classes = classes;
            ability.archetypes = archetypes;
        }
        
        res.render('manage/abilities', {
            title: 'Управление способностями',
            user: req.session.this_user,
            abilities,
            search: search || ''
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки способностей');
    }
});

// Форма создания способности
app.get('/manage/abilities/new', requireAuth, (req, res) => {
    res.render('manage/ability-form', {
        title: 'Новая способность',
        user: req.session.this_user,
        ability: null,
        isEdit: false
    });
});

// Создание способности
app.post('/manage/abilities', requireAuth, async (req, res) => {
    const { name, description } = req.body;
    
    if (!name || !name.trim()) {
        return res.send(`<script>alert('Введите название'); window.location.href='/manage/abilities/new';</script>`);
    }
    
    try {
        const [existing] = await pool.query('SELECT name, description FROM ability WHERE name = ?', [name.trim()]);
        if (existing.length > 0) {
            // Если способность существует, показываем её описание
            return res.send(`
                <script>
                    alert('Способность "${name.trim()}" уже существует!\\n\\nОписание: ${(existing[0].description || 'Нет описания').substring(0, 200)}');
                    window.location.href = '/manage/abilities';
                </script>
            `);
        }
        
        await pool.query(
            `INSERT INTO ability (name, description) VALUES (?, ?)`,
            [name.trim(), description || '']
        );
        res.redirect('/manage/abilities');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.location.href='/manage/abilities/new';</script>`);
    }
});

// Форма редактирования способности
app.get('/manage/abilities/edit/:name', requireAuth, async (req, res) => {
    try {
        const [abilities] = await pool.query('SELECT * FROM ability WHERE name = ?', [decodeURIComponent(req.params.name)]);
        if (abilities.length === 0) return res.status(404).send('Способность не найдена');
        
        res.render('manage/ability-form', {
            title: 'Редактирование способности',
            user: req.session.this_user,
            ability: abilities[0],
            isEdit: true
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки способности');
    }
});

// Обновление способности
app.post('/manage/abilities/update/:old_name', requireAuth, async (req, res) => {
    const { old_name } = req.params;
    const { name, description } = req.body;
    
    try {
        await pool.query(
            `UPDATE ability SET name = ?, description = ? WHERE name = ?`,
            [name, description || '', old_name]
        );
        res.redirect('/manage/abilities');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Удаление способности
// Удаление способности
app.post('/manage/abilities/delete/:name', requireAuth, async (req, res) => {
    const { name } = req.params;
    const decodedName = decodeURIComponent(name);
    
    try {
        // Сначала удаляем связи с классами
        await pool.query('DELETE FROM ability_class WHERE ability = ?', [decodedName]);
        // Удаляем связи с архетипами
        await pool.query('DELETE FROM ability_archetype WHERE ability = ?', [decodedName]);
        // Удаляем саму способность
        await pool.query('DELETE FROM ability WHERE name = ?', [decodedName]);
        
        res.redirect('/manage/abilities');
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// ============ УПРАВЛЕНИЕ СПОСОБНОСТЯМИ КЛАССОВ ============

// Страница управления способностями класса
app.get('/manage/class-abilities/:className', requireAuth, async (req, res) => {
    const { className } = req.params;
    const decodedClass = decodeURIComponent(className);
    
    try {
        const [classInfo] = await pool.query('SELECT * FROM class WHERE class_name = ?', [decodedClass]);
        if (classInfo.length === 0) return res.status(404).send('Класс не найден');
        
        const [abilities] = await pool.query(`
            SELECT a.name, a.description, ac.level
            FROM ability a
            JOIN ability_class ac ON a.name = ac.ability
            WHERE ac.class = ?
            ORDER BY ac.level ASC, a.name ASC
        `, [decodedClass]);
        
        // Получаем ВСЕ способности для поиска
        const [allAbilities] = await pool.query('SELECT name, description FROM ability ORDER BY name');
        
        res.render('manage/class-abilities', {
            title: `Способности класса ${decodedClass}`,
            user: req.session.this_user,
            className: decodedClass,
            classInfo: classInfo[0],
            abilities,
            allAbilities: allAbilities  // ← обязательно передаем в шаблон
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки способностей');
    }
});

// Добавление способности классу
app.post('/manage/class-abilities/add', requireAuth, async (req, res) => {
    const { class_name, ability, level } = req.body;
    
    if (!ability) {
        return res.send(`<script>alert('Выберите способность'); window.history.back();</script>`);
    }
    
    try {
        await pool.query(
            'INSERT INTO ability_class (class, ability, level) VALUES (?, ?, ?)',
            [class_name, ability, level || 1]
        );
        res.redirect(`/manage/class-abilities/${encodeURIComponent(class_name)}`);
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Удаление способности у класса
app.post('/manage/class-abilities/remove', requireAuth, async (req, res) => {
    const { class_name, ability } = req.body;
    
    try {
        await pool.query(
            'DELETE FROM ability_class WHERE class = ? AND ability = ?',
            [class_name, ability]
        );
        res.redirect(`/manage/class-abilities/${encodeURIComponent(class_name)}`);
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Проверка существования способности (для валидации)
app.get('/manage/abilities/check/:name', requireAuth, async (req, res) => {
    const { name } = req.params;
    const decodedName = decodeURIComponent(name);
    
    try {
        const [existing] = await pool.query('SELECT name FROM ability WHERE name = ?', [decodedName]);
        res.json({ exists: existing.length > 0 });
    } catch (error) {
        console.error(error);
        res.json({ exists: false, error: error.message });
    }
});







// ============ УПРАВЛЕНИЕ УМЕНИЯМИ АРХЕТИПОВ ============

// Страница управления умениями архетипа
app.get('/manage/archetype-abilities/:className/:archetypeName', requireAuth, async (req, res) => {
    const { className, archetypeName } = req.params;
    const decodedClass = decodeURIComponent(className);
    const decodedArchetype = decodeURIComponent(archetypeName);
    
    try {
        // Информация об архетипе
        const [archetype] = await pool.query('SELECT * FROM archetype WHERE class = ? AND name = ?', [decodedClass, decodedArchetype]);
        if (archetype.length === 0) return res.status(404).send('Архетип не найден');
        
        // Умения архетипа
        const [abilities] = await pool.query(`
            SELECT a.name, a.description, aa.level
            FROM ability a
            JOIN ability_archetype aa ON a.name = aa.ability
            WHERE aa.archetype = ?
            ORDER BY aa.level ASC, a.name ASC
        `, [decodedArchetype]);
        
        res.render('manage/archetype-abilities', {
            title: `Умения архетипа ${decodedArchetype}`,
            user: req.session.this_user,
            className: decodedClass,
            archetypeName: decodedArchetype,
            archetype: archetype[0],
            abilities
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки умений архетипа');
    }
});

// Добавление умения архетипу
app.post('/manage/archetype-abilities/add', requireAuth, async (req, res) => {
    const { archetype, ability, level } = req.body;
    
    if (!ability) {
        return res.status(400).send('Выберите способность');
    }
    
    try {
        await pool.query(
            'INSERT INTO ability_archetype (archetype, ability, level) VALUES (?, ?, ?)',
            [archetype, ability, level || 1]
        );
        res.redirect(`/manage/archetype-abilities/${encodeURIComponent(req.body.class_name)}/${encodeURIComponent(archetype)}`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка: ' + error.message);
    }
});

// Удаление умения у архетипа
app.post('/manage/archetype-abilities/remove', requireAuth, async (req, res) => {
    const { archetype, ability, class_name } = req.body;
    
    try {
        await pool.query(
            'DELETE FROM ability_archetype WHERE archetype = ? AND ability = ?',
            [archetype, ability]
        );
        res.redirect(`/manage/archetype-abilities/${encodeURIComponent(class_name)}/${encodeURIComponent(archetype)}`);
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка: ' + error.message);
    }
});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


// ============ УПРАВЛЕНИЕ ВОЗЗВАНИЯМИ ============

// Страница управления воззваниями класса
app.get('/manage/class-features/:className', requireAuth, async (req, res) => {
    const { className } = req.params;
    const decodedClass = decodeURIComponent(className);
    
    try {
        const [classInfo] = await pool.query('SELECT * FROM class WHERE class_name = ?', [decodedClass]);
        if (classInfo.length === 0) return res.status(404).send('Класс не найден');
        
        const [features] = await pool.query(`
            SELECT name, level, description FROM appeals WHERE class = ? ORDER BY level, name
        `, [decodedClass]);
        
        res.render('manage/class-features', {
            title: `Классовые настройки - ${decodedClass}`,
            user: req.session.this_user,
            className: decodedClass,
            classInfo: classInfo[0],
            features
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Ошибка загрузки');
    }
});

// Добавление воззвания
app.post('/manage/class-features/add', requireAuth, async (req, res) => {
    const { class_name, name, level, description } = req.body;
    
    if (!name || !name.trim()) {
        return res.send(`<script>alert('Введите название'); window.history.back();</script>`);
    }
    
    try {
        await pool.query(
            `INSERT INTO appeals (class, name, level, description) VALUES (?, ?, ?, ?)`,
            [class_name, name.trim(), parseInt(level) || 1, description || '']
        );
        res.redirect(`/manage/class-features/${encodeURIComponent(class_name)}`);
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Редактирование воззвания
app.post('/manage/class-features/edit', requireAuth, async (req, res) => {
    const { class_name, old_name, name, level, description } = req.body;
    
    try {
        await pool.query(
            `UPDATE appeals SET name = ?, level = ?, description = ? WHERE class = ? AND name = ?`,
            [name, parseInt(level) || 1, description || '', class_name, old_name]
        );
        res.redirect(`/manage/class-features/${encodeURIComponent(class_name)}`);
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});

// Удаление воззвания
app.post('/manage/class-features/delete', requireAuth, async (req, res) => {
    const { class_name, name } = req.body;
    
    try {
        await pool.query(
            `DELETE FROM appeals WHERE class = ? AND name = ?`,
            [class_name, name]
        );
        res.redirect(`/manage/class-features/${encodeURIComponent(class_name)}`);
    } catch (error) {
        console.error(error);
        res.send(`<script>alert('Ошибка: ${error.message}'); window.history.back();</script>`);
    }
});






