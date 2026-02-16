# 🚀 ORACLE PRO - GUÍA DE DEPLOYMENT COMPLETA

Esta guía te llevará paso a paso para tener ORACLE Pro funcionando 24/7 en producción, **100% GRATIS**.

---

## 📋 TABLA DE CONTENIDOS

1. [Resumen de la Arquitectura](#arquitectura)
2. [Prerrequisitos](#prerrequisitos)
3. [Setup de Base de Datos (Supabase)](#supabase)
4. [Setup de APIs Gratuitas](#apis)
5. [Deploy del Backend (Railway)](#backend)
6. [Deploy del Frontend (Vercel)](#frontend)
7. [Configuración de Alertas](#alertas)
8. [Testing y Verificación](#testing)
9. [Mantenimiento](#mantenimiento)

---

## 🏗️ ARQUITECTURA <a name="arquitectura"></a>

```
┌─────────────────────────────────────────────────────────┐
│  FRONTEND                                               │
│  Vercel (GRATIS)                                        │
│  ├─ React App                                           │
│  ├─ Responsive Design                                   │
│  └─ API Calls al Backend                                │
├─────────────────────────────────────────────────────────┤
│  BACKEND                                                │
│  Railway.app (GRATIS $5/mes)                            │
│  ├─ Express Server                                      │
│  ├─ Cron Jobs (cada 1 min: data, cada 5 min: alertas)  │
│  ├─ Telegram Bot                                        │
│  └─ APIs Integration                                    │
├─────────────────────────────────────────────────────────┤
│  DATABASE                                               │
│  Supabase (GRATIS 500MB)                                │
│  ├─ PostgreSQL                                          │
│  ├─ Real-time subscriptions                            │
│  └─ Tablas: alerts, portfolios, signals                │
├─────────────────────────────────────────────────────────┤
│  DATOS EN TIEMPO REAL                                   │
│  ├─ CoinGecko API (crypto prices)                      │
│  ├─ CoinCap API (crypto details)                       │
│  ├─ Alternative.me API (Fear & Greed)                  │
│  └─ Alpha Vantage (Gold/Silver)                        │
├─────────────────────────────────────────────────────────┤
│  ALERTAS                                                │
│  ├─ Resend.dev (Email - 3000/mes GRATIS)              │
│  └─ Telegram Bot API (SMS alternativo - GRATIS)        │
└─────────────────────────────────────────────────────────┘
```

**COSTO TOTAL: $0/mes** ✅

---

## ✅ PRERREQUISITOS <a name="prerrequisitos"></a>

Antes de empezar, necesitas crear cuentas en:

1. **GitHub** - https://github.com (para código)
2. **Vercel** - https://vercel.com (frontend)
3. **Railway** - https://railway.app (backend)
4. **Supabase** - https://supabase.com (database)
5. **Telegram** - https://telegram.org (bot)
6. **Resend** - https://resend.com (email)
7. **Alpha Vantage** - https://www.alphavantage.co (metales)

**Todas son 100% GRATIS con límites generosos.**

---

## 🗄️ SETUP DE BASE DE DATOS (SUPABASE) <a name="supabase"></a>

### Paso 1: Crear Proyecto

1. Ve a https://supabase.com
2. Click en "Start your project"
3. Crea una organización nueva
4. Crea un proyecto:
   - **Name:** oracle-pro-db
   - **Password:** (guarda esto, lo necesitarás)
   - **Region:** South America (elige el más cercano)
   - **Pricing Plan:** Free

### Paso 2: Crear Tablas

Una vez creado el proyecto, ve a **SQL Editor** y ejecuta este script:

```sql
-- Tabla de Alertas
CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY,
  asset TEXT NOT NULL,
  action TEXT NOT NULL,
  score INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  price DECIMAL(18, 8) NOT NULL,
  reasons TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla de Portfolios
CREATE TABLE portfolios (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  portfolio JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla de Signals (histórico)
CREATE TABLE signals_history (
  id BIGSERIAL PRIMARY KEY,
  asset TEXT NOT NULL,
  action TEXT NOT NULL,
  score INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  indicators JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX idx_alerts_created_at ON alerts(created_at DESC);
CREATE INDEX idx_portfolios_user_id ON portfolios(user_id);
CREATE INDEX idx_signals_created_at ON signals_history(created_at DESC);
```

### Paso 3: Obtener Credenciales

1. Ve a **Settings > API**
2. Copia estos valores (los necesitarás más adelante):
   - **Project URL** (ejemplo: `https://abcdefgh.supabase.co`)
   - **anon/public key** (empieza con `eyJ...`)

---

## 🔑 SETUP DE APIs GRATUITAS <a name="apis"></a>

### 1. Alpha Vantage (Oro & Plata)

1. Ve a https://www.alphavantage.co/support/#api-key
2. Click "Get your free API key today"
3. Llena el formulario
4. Copia tu API key

**Límite:** 500 llamadas/día (suficiente, solo actualizamos cada 5 min)

### 2. Resend (Email)

1. Ve a https://resend.com
2. Sign up con GitHub
3. Ve a **API Keys**
4. Crea una nueva key
5. Copia el valor (empieza con `re_...`)

**Límite:** 3,000 emails/mes GRATIS

### 3. Telegram Bot

1. Abre Telegram
2. Busca **@BotFather**
3. Envía `/newbot`
4. Sigue las instrucciones:
   - **Name:** ORACLE Pro Bot
   - **Username:** oracle_pro_bot (o el que quieras)
5. Copia el **Bot Token** (formato: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

**Límite:** Ilimitado y GRATIS ✅

---

## 🚂 DEPLOY DEL BACKEND (RAILWAY) <a name="backend"></a>

### Paso 1: Preparar el Código

1. Crea un repositorio en GitHub
2. Sube estos archivos:
   ```
   backend/
   ├── server.js
   ├── package.json
   └── .gitignore
   ```

3. Crea `.gitignore`:
   ```
   node_modules/
   .env
   ```

### Paso 2: Deploy en Railway

1. Ve a https://railway.app
2. Click "Start a New Project"
3. Selecciona "Deploy from GitHub repo"
4. Conecta tu cuenta de GitHub
5. Selecciona el repositorio con el backend

### Paso 3: Configurar Variables de Entorno

En Railway, ve a **Variables** y agrega:

```env
NODE_ENV=production
PORT=3001

# Supabase
SUPABASE_URL=https://tuproyecto.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# APIs
ALPHA_VANTAGE_KEY=TU_API_KEY_AQUI
RESEND_API_KEY=re_123456789...
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjkl...

# Opcional (para IA)
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### Paso 4: Deploy

1. Railway detectará automáticamente Node.js
2. Click **Deploy**
3. Espera 2-3 minutos
4. Copia la URL del deployment (ejemplo: `https://oracle-backend.up.railway.app`)

### Paso 5: Verificar

Visita `https://TU_URL.railway.app` en el navegador.

Deberías ver:
```json
{
  "status": "ORACLE Backend Online",
  "version": "1.0.0",
  "lastUpdate": "2026-02-15T..."
}
```

---

## ⚡ DEPLOY DEL FRONTEND (VERCEL) <a name="frontend"></a>

### Paso 1: Preparar el Código

1. Crea una carpeta `frontend/` en tu repo
2. Si usas Next.js:
   ```bash
   npx create-next-app@latest oracle-pro-frontend
   cd oracle-pro-frontend
   ```

3. Reemplaza el contenido de `app/page.js` con `oracle-pro-frontend.jsx`

4. Modifica el archivo para que exporte como default:
   ```javascript
   // app/page.js
   import OracleProFrontend from './OracleProFrontend'
   
   export default function Home() {
     return <OracleProFrontend />
   }
   ```

### Paso 2: Configurar Variables de Entorno

Crea `.env.local`:
```env
NEXT_PUBLIC_API_URL=https://TU_BACKEND.railway.app
```

### Paso 3: Deploy en Vercel

1. Ve a https://vercel.com
2. Click "Add New" > "Project"
3. Import tu repositorio de GitHub
4. Vercel detectará Next.js automáticamente
5. En **Environment Variables**, agrega:
   - `NEXT_PUBLIC_API_URL` = `https://TU_BACKEND.railway.app`
6. Click **Deploy**

### Paso 4: Verificar

En 2-3 minutos, tu app estará en:
```
https://oracle-pro-frontend.vercel.app
```

**¡Ya está funcionando 24/7!** 🎉

---

## 📧 CONFIGURACIÓN DE ALERTAS <a name="alertas"></a>

### Email (Resend)

Las alertas por email ya funcionan automáticamente si configuraste `RESEND_API_KEY`.

**Para personalizar el sender:**

1. Ve a Resend dashboard
2. **Domains** > Add domain
3. Agrega tu dominio (opcional, puedes usar el de Resend)
4. Verifica los DNS records

### Telegram Bot

**Para recibir alertas:**

1. Abre Telegram
2. Busca tu bot: `@tu_bot_username`
3. Envía `/start`
4. Envía `/alertas` para suscribirte

**Comandos disponibles:**
- `/precio BTC` - Ver precio de Bitcoin
- `/señales` - Ver señales activas
- `/mercado` - Resumen del mercado
- `/stop` - Desuscribirse

---

## ✅ TESTING Y VERIFICACIÓN <a name="testing"></a>

### Test Backend

```bash
# Verificar que el server está online
curl https://TU_BACKEND.railway.app

# Ver datos de mercado
curl https://TU_BACKEND.railway.app/api/market

# Ver señales
curl https://TU_BACKEND.railway.app/api/signals
```

### Test Frontend

1. Abre `https://TU_FRONTEND.vercel.app`
2. Debería mostrar:
   - Dashboard con precios en tiempo real
   - Fear & Greed Index
   - Señales activas
   - Portfolio (vacío al inicio)

### Test Alertas

**Email:**
1. Ve a la pestaña **Alertas**
2. Configura tu email
3. Click "Enviar alerta de prueba"
4. Revisa tu inbox (también spam)

**Telegram:**
1. Envía `/start` a tu bot
2. Espera 5 minutos
3. Si hay señales con alta confianza, recibirás una alerta

---

## 🔧 MANTENIMIENTO <a name="mantenimiento"></a>

### Monitoreo

**Railway Dashboard:**
- Logs en tiempo real
- Uso de CPU/Memoria
- Requests por minuto

**Vercel Dashboard:**
- Analytics
- Performance
- Error tracking

### Límites de APIs Gratuitas

| Servicio | Límite | Uso Estimado | Suficiente? |
|----------|--------|--------------|-------------|
| CoinGecko | 50 calls/min | ~1 call/min | ✅ Sí (2%) |
| Alpha Vantage | 500 calls/día | ~288 calls/día | ✅ Sí (58%) |
| Resend | 3000 emails/mes | ~150/mes | ✅ Sí (5%) |
| Telegram | Ilimitado | Ilimitado | ✅ Sí |
| Supabase | 500MB | ~10MB | ✅ Sí (2%) |
| Railway | $5 credit/mes | ~$3/mes | ✅ Sí (60%) |

**Todos los servicios tienen espacio de sobra.** 🎉

### Actualizar el Sistema

```bash
# Haz cambios en tu código local
git add .
git commit -m "Update: descripción del cambio"
git push origin main

# Railway y Vercel re-deployarán automáticamente
```

### Backup

Supabase hace backups automáticos. Para backup manual:

```bash
# En Supabase dashboard
Settings > Database > Backup
```

---

## 🎯 NEXT STEPS

Ahora que tienes ORACLE Pro funcionando 24/7:

### Mejoras Recomendadas:

1. **Custom Domain** (opcional)
   - Vercel: Settings > Domains > Add
   - Ejemplo: `oracle-pro.tudominio.com`

2. **More Assets**
   - Agregar más cryptos
   - Agregar índices (S&P 500, Nasdaq)

3. **Advanced Indicators**
   - Fibonacci retracements
   - Elliott Waves
   - On-chain metrics

4. **Social Sentiment**
   - Twitter API
   - Reddit sentiment
   - News aggregation

5. **Mobile App**
   - React Native
   - Push notifications nativas

---

## 🆘 TROUBLESHOOTING

### "Backend no responde"

```bash
# Ver logs en Railway
railway logs

# Verificar variables de entorno
railway vars
```

### "Precios no se actualizan"

1. Verifica que los cron jobs están corriendo
2. Revisa logs para errores de API
3. Confirma que las API keys son válidas

### "Alertas no llegan"

**Email:**
- Verifica que `RESEND_API_KEY` está configurada
- Revisa spam
- Confirma que el dominio está verificado

**Telegram:**
- Verifica que `TELEGRAM_BOT_TOKEN` está configurado
- Confirma que enviaste `/start` al bot
- Revisa logs del backend

---

## 📞 SOPORTE

Si tienes problemas:

1. Revisa los logs en Railway/Vercel
2. Verifica las variables de entorno
3. Confirma que todas las APIs están activas
4. Revisa la consola del navegador (F12)

---

## 🎉 ¡FELICITACIONES!

Ahora tienes un **sistema de trading profesional funcionando 24/7**, completamente gratis, con:

✅ Datos en tiempo real (crypto + metales)  
✅ Señales inteligentes con IA  
✅ Alertas automáticas (email + Telegram)  
✅ Portfolio tracking  
✅ Accesible desde cualquier dispositivo  
✅ Escalable a futuro  

**¡A hacer trading inteligente!** 🚀📈
