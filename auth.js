// ===== Tapa Delay — Autenticação Supabase =====
const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

const SUPABASE_URL      = 'https://crdmzsdgrdeaybizwbke.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNyZG16c2RncmRlYXliaXp3YmtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNTcyNTMsImV4cCI6MjA5NTgzMzI1M30.ex5_CDQrTeRdPWqs56WWithzi-2NC-27gM7MUXg1KH8';
const TRIAL_DAYS        = 30;

// Armazena sessão em arquivo (sem localStorage no processo principal)
let _sessionFile = null;
function getSessionFile() {
    if (!_sessionFile) _sessionFile = path.join(app.getPath('userData'), 'td-session.json');
    return _sessionFile;
}

const storage = {
    getItem(key) {
        try {
            const data = JSON.parse(fs.readFileSync(getSessionFile(), 'utf8'));
            return data[key] ?? null;
        } catch { return null; }
    },
    setItem(key, value) {
        try {
            let data = {};
            try { data = JSON.parse(fs.readFileSync(getSessionFile(), 'utf8')); } catch {}
            data[key] = value;
            fs.writeFileSync(getSessionFile(), JSON.stringify(data), 'utf8');
        } catch {}
    },
    removeItem(key) {
        try {
            let data = {};
            try { data = JSON.parse(fs.readFileSync(getSessionFile(), 'utf8')); } catch {}
            delete data[key];
            fs.writeFileSync(getSessionFile(), JSON.stringify(data), 'utf8');
        } catch {}
    }
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        storage,
        autoRefreshToken: true,
        detectSessionInUrl: false,
    }
});

async function signUp(email, password, name) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { success: false, error: error.message };
    if (!data.session) return { success: true, needsConfirmation: true };
    // Salva o nome no perfil logo após o cadastro
    if (name && data.user) {
        await supabase.from('profiles').update({ name: name.trim() }).eq('id', data.user.id);
    }
    return { success: true, needsConfirmation: false };
}

async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message };
    return { success: true };
}

async function signOut() {
    try { await supabase.auth.signOut(); } catch {}
}

async function checkAccess() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return { hasAccess: false, reason: 'not_logged_in' };

        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single();

        if (error || !profile) return { hasAccess: false, reason: 'not_logged_in' };

        const email = session.user.email;

        const userId = session.user.id;

        const name = profile.name || null;

        if (profile.subscription_status === 'active') {
            return { hasAccess: true, reason: 'active_subscription', email, userId, name };
        }

        if (profile.subscription_status === 'trial') {
            const trialEnd  = new Date(new Date(profile.trial_started_at).getTime() + TRIAL_DAYS * 86400000);
            const daysLeft  = Math.ceil((trialEnd - Date.now()) / 86400000);
            if (daysLeft > 0) return { hasAccess: true, reason: 'trial', daysLeft, email, userId, name };
            return { hasAccess: false, reason: 'trial_expired', email, userId, name };
        }

        if (!profile.subscription_status || profile.subscription_status === 'inactive') {
            return { hasAccess: false, reason: 'no_subscription', email, userId, name };
        }

        return { hasAccess: false, reason: 'subscription_cancelled', email, userId, name };
    } catch (e) {
        console.error('[Auth] checkAccess:', e.message);
        return { hasAccess: false, reason: 'error' };
    }
}

async function redeemCode(userId, code) {
    try {
        const { data, error } = await supabase.rpc('redeem_promo_code', {
            p_user_id: userId,
            p_code: code.trim().toUpperCase()
        });
        if (error) return { success: false, error: 'Erro ao validar código.' };
        if (data === 'success') return { success: true };
        return { success: false, error: 'Código inválido ou já utilizado.' };
    } catch (e) {
        return { success: false, error: 'Erro de conexão.' };
    }
}

module.exports = { signUp, signIn, signOut, checkAccess, redeemCode };
