# 🚀 ORACLE PRO - Sistema de Trading Profesional

<div align="center">

![ORACLE PRO](https://img.shields.io/badge/ORACLE-PRO-a855f7?style=for-the-badge)
![Status](https://img.shields.io/badge/STATUS-PRODUCTION-00d4aa?style=for-the-badge)
![Cost](https://img.shields.io/badge/COST-$0%2Fmonth-00d4aa?style=for-the-badge)

**Sistema de análisis y alertas para trading de crypto y metales preciosos**  
*Con IA, datos en tiempo real y alertas automáticas*

[🎯 Demo](#demo) · [📖 Docs](#documentacion) · [🚀 Deploy](#deployment) · [🆘 Support](#soporte)

</div>

---

## 📋 Índice

- [Características](#caracteristicas)
- [Tecnologías](#tecnologias)
- [Arquitectura](#arquitectura)
- [Quick Start](#quick-start)
- [Deployment](#deployment)
- [Uso](#uso)
- [APIs Utilizadas](#apis)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

---

## ✨ Características <a name="caracteristicas"></a>

### 🎯 Core Features

- ✅ **Datos en Tiempo Real** - Actualización cada 30 segundos
- ✅ **12 Activos** - 10 cryptos + Oro + Plata
- ✅ **Señales Inteligentes** - Score y confianza basado en múltiples indicadores
- ✅ **Alertas Multi-Canal** - Email + Telegram
- ✅ **Portfolio Tracking** - Seguimiento de posiciones y P&L
- ✅ **Análisis Técnico** - RSI, MACD, Bollinger Bands, Volumen, Tendencia
- ✅ **Predicciones IA** - Escenarios probabilísticos 24h/7d/30d
- ✅ **100% Gratis** - Sin costos de hosting ni APIs

### 📊 Indicadores Técnicos

| Indicador | Descripción | Uso |
|-----------|-------------|-----|
| **RSI (14)** | Relative Strength Index | Detecta sobrecompra/sobreventa |
| **MACD** | Moving Average Convergence Divergence | Identifica cambios de tendencia |
| **Bollinger Bands** | Volatilidad y niveles extremos | Puntos de entrada/salida |
| **Volume Analysis** | Análisis de volumen vs promedio | Confirma movimientos |
| **Support/Resistance** | Niveles clave de precio | Zonas de rebote/rechazo |
| **Trend Strength** | Fuerza de tendencia vs MA50 | Dirección del mercado |

### 🔔 Sistema de Alertas

**Tipos de alertas automáticas:**

1. **🟢 BUY OPPORTUNITY** - Señales de compra con alta confianza (≥75%)
2. **🔴 SELL URGENT** - Señales de venta críticas
3. **⚠️ CRITICAL LEVELS** - Cerca de soportes/resistencias clave
4. **📰 MARKET NEWS** - Cambios macro importantes (Extreme Fear, Whales, VIX)

**Canales de notificación:**

- 📧 **Email** - Vía Resend (3,000/mes gratis)
- 📱 **Telegram** - Bot instantáneo (ilimitado gratis)

### 🎨 Interfaz

- 📱 **Responsive Design** - Mobile, tablet, desktop
- 🌙 **Dark Theme** - Optimizado para trading
- ⚡ **Live Updates** - Datos en tiempo real sin recargar
- 📊 **Dashboard Completo** - Overview, señales, portfolio, alertas

---

## 🛠️ Tecnologías <a name="tecnologias"></a>

### Frontend
- **React** - UI Library
- **Next.js** - Framework (opcional)
- **Vercel** - Hosting (GRATIS)

### Backend
- **Node.js** - Runtime
- **Express** - Web Framework
- **node-cron** - Scheduled tasks
- **Railway** - Hosting (GRATIS)

### Database
- **Supabase** - PostgreSQL (GRATIS 500MB)
- **Real-time subscriptions**

### APIs (Todas Gratuitas)
- **CoinGecko** - Crypto prices (50 calls/min)
- **CoinCap** - Crypto details (unlimited)
- **Alternative.me** - Fear & Greed Index
- **Alpha Vantage** - Gold/Silver prices (500/day)

### Alertas
- **Resend** - Email (3,000/mes)
- **Telegram Bot API** - Mensajería (unlimited)

---

## 🏗️ Arquitectura <a name="arquitectura"></a>

```
┌──────────────────────────────────────────────────────────┐
│                    USUARIO                               │
│  (Mobile, Tablet, Desktop)                               │
└────────────────┬─────────────────────────────────────────┘
                 │
    ┌────────────▼────────────┐
    │   FRONTEND (Vercel)     │
    │  - React UI             │
    │  - Real-time updates    │
    │  - Portfolio tracking   │
    └────────────┬────────────┘
                 │ API Calls
    ┌────────────▼────────────┐
    │  BACKEND (Railway)      │
    │  - Express Server       │
    │  - Cron Jobs            │
    │  - Signal Generation    │
    │  - Alert Processing     │
    └───┬──────┬──────┬───────┘
        │      │      │
  ┌─────▼──┐ ┌▼─────┐│
  │Database│ │ APIs ││
  │Supabase│ │CoinG.││
  └────────┘ └──────┘│
                      │
        ┌─────────────▼──────────────┐
        │   ALERTS DELIVERY          │
        │  - Email (Resend)          │
        │  - Telegram Bot            │
        └────────────────────────────┘
```

---

## 🚀 Quick Start <a name="quick-start"></a>

### Prerrequisitos

- Node.js ≥ 18.0.0
- npm o yarn
- Cuenta en GitHub

### Instalación Local

```bash
# 1. Clonar el repositorio
git clone https://github.com/tu-usuario/oracle-pro.git
cd oracle-pro

# 2. Instalar dependencias del backend
cd backend
npm install

# 3. Configurar variables de entorno
cp .env.example .env
# Edita .env con tus API keys

# 4. Iniciar el backend
npm run dev

# 5. En otra terminal, instalar frontend
cd ../frontend
npm install

# 6. Iniciar frontend
npm run dev
```

### Acceder a la aplicación

- **Frontend:** http://localhost:3000
- **Backend:** http://localhost:3001
- **API Docs:** http://localhost:3001/api/market

---

## 🌍 Deployment <a name="deployment"></a>

### Deploy Rápido (15 minutos)

Sigue la [**GUÍA COMPLETA DE DEPLOYMENT**](./DEPLOYMENT_GUIDE.md) para instrucciones detalladas.

**Resumen:**

1. **Database:** Crear proyecto en Supabase
2. **Backend:** Deploy en Railway con variables de entorno
3. **Frontend:** Deploy en Vercel
4. **Alertas:** Configurar Telegram Bot + Resend

**Todo gratis, 24/7, sin tarjeta de crédito.**

---

## 📖 Uso <a name="uso"></a>

### Dashboard

Ver overview del mercado:
- Fear & Greed Index
- Top gainers/losers
- Precios en tiempo real
- Señales activas

### Señales

Recibe señales de trading con:
- **Score** (0-100) - Fuerza de la señal
- **Confidence** (0-100%) - Nivel de confianza
- **Action** - BUY, SELL, o HOLD
- **Reasons** - Indicadores que generaron la señal

### Portfolio

Trackea tus posiciones:
1. Agrega una posición (asset, cantidad, precio de compra)
2. Ve tu P&L en tiempo real
3. Exporta o modifica posiciones

### Alertas

Configura alertas automáticas:
1. Ingresa tu email
2. Ajusta confianza mínima (default: 75%)
3. Activa tipos de alertas
4. Recibe notificaciones cuando hay oportunidades

### Telegram Bot

**Comandos disponibles:**

```
/start - Iniciar el bot
/precio BTC - Ver precio de Bitcoin
/precio ETH - Ver precio de Ethereum
/señales - Ver todas las señales activas
/mercado - Resumen macro del mercado
/alertas - Suscribirse a alertas
/stop - Desuscribirse
```

---

## 🔌 APIs Utilizadas <a name="apis"></a>

| API | Uso | Límite | Costo |
|-----|-----|--------|-------|
| **CoinGecko** | Precios crypto | 50 calls/min | GRATIS |
| **CoinCap** | Detalles crypto | Unlimited | GRATIS |
| **Alternative.me** | Fear & Greed | Unlimited | GRATIS |
| **Alpha Vantage** | Oro/Plata | 500 calls/día | GRATIS |
| **Resend** | Email | 3,000/mes | GRATIS |
| **Telegram** | Mensajería | Unlimited | GRATIS |
| **Supabase** | Database | 500MB | GRATIS |

**Total: $0/mes** ✅

---

## 🎯 Roadmap

### v1.0 (Actual) ✅
- [x] Datos en tiempo real
- [x] 12 activos (10 crypto + 2 metales)
- [x] Señales inteligentes
- [x] Alertas email + Telegram
- [x] Portfolio tracking
- [x] Deploy gratuito 24/7

### v1.1 (Próximo)
- [ ] Más indicadores (Fibonacci, Elliott Waves)
- [ ] Sentiment analysis (Twitter, Reddit)
- [ ] On-chain metrics
- [ ] Backtesting avanzado
- [ ] Mobile app (React Native)

### v2.0 (Futuro)
- [ ] Machine Learning predictions
- [ ] Social trading (copiar portfolios)
- [ ] Exchange integration (trading directo)
- [ ] Webhook alerts
- [ ] Multi-usuario con autenticación

---

## 🤝 Contribuir <a name="contribuir"></a>

¡Las contribuciones son bienvenidas!

1. Fork el proyecto
2. Crea una rama (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

---

## 🆘 Soporte <a name="soporte"></a>

Si tienes problemas:

1. Revisa la [Guía de Deployment](./DEPLOYMENT_GUIDE.md)
2. Busca en [Issues](https://github.com/tu-usuario/oracle-pro/issues)
3. Crea un nuevo Issue con detalles

---

## 📄 Licencia <a name="licencia"></a>

Este proyecto está bajo la Licencia MIT - ver el archivo [LICENSE](LICENSE) para detalles.

---

## ⚠️ Disclaimer

**ORACLE Pro es una herramienta de análisis.** No constituye asesoramiento financiero. Siempre haz tu propia investigación (DYOR) antes de tomar decisiones de inversión.

---

## 🌟 Star History

Si este proyecto te ayuda, considera darle una ⭐ en GitHub!

---

<div align="center">

**Hecho con 💜 por la comunidad de trading**

[⬆ Volver arriba](#-oracle-pro---sistema-de-trading-profesional)

</div>
