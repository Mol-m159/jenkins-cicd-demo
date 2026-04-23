// Проверка, авторизован ли пользователь
function requireAuth(req, res, next) {
    if (!req.session.this_user) {
        return res.redirect('/entranse');
    }
    next();
}

// Проверка, что пользователь имеет доступ к ресурсу
function checkUserAccess(req, res, next) {
    const requestedUser = req.params.username || req.query.username;
    
    if (!req.session.this_user) {
        return res.redirect('/entranse');
    }
    
    if (requestedUser && requestedUser !== req.session.this_user) {
        return res.status(403).send(`
            <script>
                alert('У вас нет доступа к этой странице');
                window.location.href = '/';
            </script>
        `);
    }
    
    next();
}

module.exports = { requireAuth, checkUserAccess };