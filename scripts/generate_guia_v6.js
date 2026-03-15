const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat,
  TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
  PageNumber, PageBreak } = require('docx');
const fs = require('fs');

const purple = "7C3AED";
const darkPurple = "5B21B6";
const lightPurple = "EDE9FE";
const green = "10B981";
const red = "EF4444";
const amber = "F59E0B";
const gray = "6B7280";
const lightGray = "F3F4F6";
const white = "FFFFFF";
const black = "111827";

const border = { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

const pageWidth = 12240;
const margins = { top: 1440, right: 1260, bottom: 1440, left: 1260 };
const contentWidth = pageWidth - margins.left - margins.right;

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 200 }, children: [new TextRun({ text, bold: true, size: 32, font: "Arial", color: darkPurple })] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 160 }, children: [new TextRun({ text, bold: true, size: 26, font: "Arial", color: purple })] });
}
function h3(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 120 }, children: [new TextRun({ text, bold: true, size: 22, font: "Arial", color: "374151" })] });
}
function p(text, opts = {}) {
  return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text, size: 21, font: "Arial", color: opts.color || black, bold: opts.bold, italics: opts.italic })] });
}
function pRuns(runs) {
  return new Paragraph({ spacing: { after: 120 }, children: runs.map(r => new TextRun({ text: r.text, size: 21, font: "Arial", color: r.color || black, bold: r.bold, italics: r.italic })) });
}
function tip(text) {
  return new Paragraph({ spacing: { after: 140 }, indent: { left: 200 }, border: { left: { style: BorderStyle.SINGLE, size: 6, color: amber, space: 8 } }, children: [new TextRun({ text: "\u{1F4A1} TIP: ", size: 20, font: "Arial", bold: true, color: amber }), new TextRun({ text, size: 20, font: "Arial", color: "92400E" })] });
}
function alert(text) {
  return new Paragraph({ spacing: { after: 140 }, indent: { left: 200 }, border: { left: { style: BorderStyle.SINGLE, size: 6, color: red, space: 8 } }, children: [new TextRun({ text: "\u26A0\uFE0F IMPORTANTE: ", size: 20, font: "Arial", bold: true, color: red }), new TextRun({ text, size: 20, font: "Arial", color: "991B1B" })] });
}

function makeTable(headers, rows, colWidths) {
  if (!colWidths) {
    const w = Math.floor(contentWidth / headers.length);
    colWidths = headers.map((_, i) => i === headers.length - 1 ? contentWidth - w * (headers.length - 1) : w);
  }
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => new TableCell({
      borders, width: { size: colWidths[i], type: WidthType.DXA },
      shading: { fill: lightPurple, type: ShadingType.CLEAR },
      margins: cellMargins,
      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18, font: "Arial", color: darkPurple })] })]
    }))
  });
  const dataRows = rows.map((row, ri) => new TableRow({
    children: row.map((cell, ci) => new TableCell({
      borders, width: { size: colWidths[ci], type: WidthType.DXA },
      shading: ri % 2 === 1 ? { fill: "F9FAFB", type: ShadingType.CLEAR } : undefined,
      margins: cellMargins,
      children: [new Paragraph({ children: [new TextRun({ text: String(cell), size: 18, font: "Arial", color: black })] })]
    }))
  }));
  return new Table({ width: { size: contentWidth, type: WidthType.DXA }, columnWidths: colWidths, rows: [headerRow, ...dataRows] });
}

function bullet(text, ref = "bullets", level = 0) {
  return new Paragraph({ numbering: { reference: ref, level }, spacing: { after: 60 }, children: [new TextRun({ text, size: 21, font: "Arial" })] });
}
function numberedItem(text, ref = "steps", level = 0) {
  return new Paragraph({ numbering: { reference: ref, level }, spacing: { after: 80 }, children: [new TextRun({ text, size: 21, font: "Arial" })] });
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 21 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 32, bold: true, font: "Arial", color: darkPurple }, paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 26, bold: true, font: "Arial", color: purple }, paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 22, bold: true, font: "Arial", color: "374151" }, paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 } },
    ]
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "\u25E6", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } }
      ]},
      { reference: "steps", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps2", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps3", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps4", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps5", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps6", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps7", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "bullets2", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [
    // === COVER PAGE ===
    {
      properties: { page: { size: { width: pageWidth, height: 15840 }, margin: margins } },
      children: [
        new Paragraph({ spacing: { before: 3000 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "SENTIX PRO", bold: true, size: 72, font: "Arial", color: purple })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: "Guia Completa del Sistema de Trading", size: 28, font: "Arial", color: gray })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: "Motor de 14 Factores | Multi-Timeframe | Derivados | Order Book | Macro", size: 20, font: "Arial", color: gray })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: "Paper Trading | Backtesting | Optimizacion | Portfolio Management", size: 20, font: "Arial", color: gray })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: "Risk Engine | Kelly Criterion | Kill Switch | Monte Carlo", size: 20, font: "Arial", color: gray })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 600 }, children: [new TextRun({ text: "Version 6.0", bold: true, size: 36, font: "Arial", color: darkPurple })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 400 }, children: [new TextRun({ text: "Documento Confidencial", italics: true, size: 20, font: "Arial", color: gray })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 100 }, children: [new TextRun({ text: "Marzo 2026", size: 20, font: "Arial", color: gray })] }),
      ]
    },
    // === TABLE OF CONTENTS ===
    {
      properties: { page: { size: { width: pageWidth, height: 15840 }, margin: margins } },
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: "Sentix Pro v6.0 - Guia Completa", size: 16, font: "Arial", color: gray, italics: true })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Pagina ", size: 16, font: "Arial", color: gray }), new TextRun({ children: [PageNumber.CURRENT], size: 16, font: "Arial", color: gray })] })] }) },
      children: [
        h1("Contenido"),
        new TableOfContents("Tabla de Contenidos", { hyperlink: true, headingStyleRange: "1-3" }),
        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 1: QUE ES SENTIX PRO
        // =============================================
        h1("1. Que es Sentix Pro?"),
        p("Sentix Pro es un sistema profesional de trading de criptomonedas que combina un motor de senales de 14 factores con herramientas avanzadas de gestion de riesgo, backtesting, optimizacion y gestion de portafolio."),

        h2("1.1 Componentes Principales"),
        makeTable(["Componente", "Descripcion"], [
          ["Motor de Senales", "Analiza 14 factores tecnicos, derivados y macroeconomicos en 3 timeframes (4H, 1H, 15M) para generar senales BUY, SELL o HOLD con niveles de entrada, stop-loss, take-profit y trailing stop."],
          ["Paper Trading", "Simula trades en tiempo real con capital virtual. Tracking completo de P&L, win rate, drawdown, Sharpe ratio y profit factor."],
          ["Backtesting", "Prueba la estrategia contra datos historicos (3-200+ dias) con metricas de rendimiento, validacion walk-forward y analisis Monte Carlo."],
          ["Optimizacion", "Grid search automatizado con walk-forward validation para encontrar la configuracion optima."],
          ["Portfolio Management (APM)", "Gestion multi-wallet con soporte para 17 proveedores, CSV batch upload y vista consolidada de holdings."],
          ["Execution System", "Sistema de ordenes con ciclo de vida completo, adaptadores de ejecucion (Paper, Bybit) y audit trail."],
          ["Risk Engine", "Validacion pre-trade, circuit breaker por drawdown, kill switch de emergencia y limites de correlacion."],
          ["Kelly Criterion", "Position sizing dinamico basado en el historial de rendimiento del trader."],
          ["Auto-Tuner", "Optimizacion automatica de parametros con aprobacion via Telegram."],
          ["Dashboard Analytics", "Graficos interactivos de equity, P&L diario, rendimiento por activo y curva de backtest."],
          ["Alertas", "Filtros avanzados por activo, tipo, confianza, score, R:R y confluencia. Canales: Telegram y Email."],
        ], [3000, contentWidth - 3000]),

        h2("1.2 Activos Soportados"),
        p("Sentix Pro analiza 10 criptomonedas principales en tiempo real:"),
        makeTable(["Activo", "Simbolo"], [
          ["Bitcoin", "BTC"], ["Ethereum", "ETH"], ["Binance Coin", "BNB"], ["Solana", "SOL"], ["Cardano", "ADA"],
          ["Ripple", "XRP"], ["Polkadot", "DOT"], ["Dogecoin", "DOGE"], ["Avalanche", "AVAX"], ["Chainlink", "LINK"],
        ], [contentWidth / 2, contentWidth / 2]),

        h2("1.3 Arquitectura del Sistema"),
        p("El sistema opera con una arquitectura multi-proceso para maximo rendimiento:"),
        makeTable(["Proceso", "Funcion", "Frecuencia"], [
          ["Orchestrator", "Coordina todos los procesos via IPC", "Continuo"],
          ["API Server", "Endpoints REST + SSE streaming en tiempo real", "Bajo demanda"],
          ["Market Worker", "Actualiza precios, macro (DXY, Fear&Greed, BTC dom)", "Cada 1 minuto"],
          ["Alerts Worker", "Genera senales, envia alertas, evalua paper trades", "Cada 5 minutos"],
          ["Compute Workers", "Backtests (5 concurrentes) y optimizaciones (3 concurrentes)", "Bajo demanda"],
        ], [2500, 4000, contentWidth - 6500]),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 2: ANATOMIA DE UNA SENAL
        // =============================================
        h1("2. Anatomia de una Senal"),
        p("Cada tarjeta de senal muestra la siguiente informacion:"),

        h2("2.1 Encabezado"),
        makeTable(["Elemento", "Significado"], [
          ["Verde + nombre", "Senal de COMPRA"],
          ["Rojo + nombre", "Senal de VENTA"],
          ["Blanco + nombre", "HOLD (esperar)"],
          ["Precio actual", "Ultimo precio del activo"],
          ["% 24h", "Cambio de precio en las ultimas 24 horas"],
        ], [3000, contentWidth - 3000]),

        h2("2.2 Badges"),
        makeTable(["Badge", "Significado"], [
          ["CONFLUENCIA FUERTE (verde)", "Los 3 timeframes (4H, 1H, 15M) estan de acuerdo"],
          ["CONFLUENCIA MODERADA (amarillo)", "2 de 3 timeframes de acuerdo"],
          ["CONFLICTO (rojo)", "Los timeframes se contradicen"],
          ["X% confianza", "Que tan seguro esta el motor de la senal (max 85%)"],
          ["Score X/100", "Puntaje general de la senal"],
        ], [4000, contentWidth - 4000]),

        h2("2.3 Freshness / TTL de la Senal (NUEVO v6.0)"),
        p("Las senales ahora tienen un tiempo de vida (TTL) de 15 minutos. La confianza decae automaticamente:"),
        makeTable(["Tiempo", "Estado", "Confianza"], [
          ["0-5 min", "FRESH (verde)", "100% del valor original"],
          ["5-10 min", "AGING (amarillo)", "Se reduce -5% por minuto"],
          ["10-15 min", "STALE (naranja)", "Significativamente reducida"],
          ["> 15 min", "EXPIRED (gris)", "0% - Senal descartada"],
        ], [2500, 3500, contentWidth - 6000]),
        tip("No operes senales con mas de 10 minutos de antiguedad. Las condiciones del mercado cambian rapidamente."),

        h2("2.4 Order Book (Presion de Mercado)"),
        makeTable(["Elemento", "Significado"], [
          ["BID/ASK 1.85x", "Ratio de volumen de compra vs venta. > 1.5 = presion compradora"],
          ["SPREAD 0.015%", "Diferencia entre mejor bid y best ask. Menor = mas liquidez"],
          ["BULLISH PRESSURE (verde)", "Significativamente mas ordenes de compra que de venta"],
          ["BEARISH PRESSURE (rojo)", "Significativamente mas ordenes de venta que de compra"],
          ["BALANCED (gris)", "Ordenes equilibradas, sin presion clara"],
        ], [4000, contentWidth - 4000]),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 3: TIMEFRAMES
        // =============================================
        h1("3. Barra de Timeframes (4H / 1H / 15M)"),
        p("Tres bloques que muestran que dice cada temporalidad:"),
        makeTable(["Timeframe", "Peso", "Que representa"], [
          ["4H", "40%", "Tendencia macro. La direccion del mercado en las ultimas horas."],
          ["1H", "40%", "Senal principal. El timeframe donde se genera la senal de trading."],
          ["15M", "20%", "Timing de entrada. Confirma si el momento exacto es bueno para entrar."],
        ], [1800, 1200, contentWidth - 3000]),

        h2("3.1 Como Interpretarlo"),
        makeTable(["Confluencia", "Probabilidad", "Accion"], [
          ["3/3 de acuerdo (verde)", "Alta", "Posicion completa. Todas las temporalidades apuntan en la misma direccion."],
          ["2/3 de acuerdo (amarillo)", "Moderada", "Entra con menor posicion (50-75%)."],
          ["Conflicto (rojo)", "Baja", "No operes hasta que se aclare."],
        ], [3000, 2000, contentWidth - 5000]),

        h2("3.2 Trend Governor"),
        p("El 4H actua como gobernador. Si el 4H tiene una tendencia fuerte (ADX > 30), puede anular senales conflictivas del 1H. El multiplicador de confluencia es:"),
        makeTable(["Condicion", "Multiplicador"], [
          ["3+ timeframes alineados", "x1.15 (boost)"],
          ["Conflicto entre timeframes", "x0.70 (penalizacion)"],
          ["4H fuerte vs 1H contrario", "4H prevalece (Trend Governor)"],
        ], [contentWidth / 2, contentWidth / 2]),
        tip("Nunca vayas contra la tendencia del 4H. Es el gobernador de la estrategia."),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 4: NIVELES DE OPERACION
        // =============================================
        h1("4. Niveles de Operacion (Trade Levels)"),
        p("Este panel solo aparece en senales de BUY o SELL (no en HOLD):"),
        makeTable(["Nivel", "Color", "Que significa"], [
          ["ENTRADA", "Blanco", "Precio al que deberias entrar"],
          ["STOP LOSS", "Rojo", "Precio maximo de perdida. Si llega aqui, vende para proteger tu capital."],
          ["TP1", "Verde", "Primer objetivo de ganancia. Toma al menos 50% de tu posicion aqui."],
          ["TP2", "Verde", "Segundo objetivo (mas ambicioso). Deja correr el resto hasta aqui."],
          ["TRAILING STOP", "Amarillo", "Stop dinamico que sube con el precio para proteger ganancias."],
          ["ACTIVA EN", "Blanco", "Precio donde se activa el trailing stop."],
          ["R:R", "Verde/Rojo", "Ratio riesgo/recompensa. Verde si >= 1.5, rojo si menor."],
        ], [2500, 1500, contentWidth - 4000]),

        h2("4.1 Trailing Stop - Protector de Ganancias"),
        makeTable(["Concepto", "Detalle"], [
          ["Distancia inicial", "2.5 x ATR (mas ancho que acciones por volatilidad crypto)"],
          ["Se activa cuando", "Tu trade tiene 2.5 x ATR de ganancia"],
          ["Multiplicador trailing", "3.5 x ATR de distancia"],
        ], [3000, contentWidth - 3000]),

        p("Ejemplo practico (BUY en Bitcoin a $100,000, ATR = $2,000):", { bold: true }),
        bullet("Trailing stop inicial: $95,000 (100,000 - 2.5 x 2,000)"),
        bullet("Se activa en: $105,000 (ganancia de 2.5 ATR)"),
        bullet("BTC sube a $108,000 -> trailing sube a $101,000"),
        bullet("BTC cae a $101,000 -> vendes con ganancia de $1,000"),
        alert("Sin trailing stop, muchos traders ven +20% de ganancia y luego el precio se devuelve a 0%. El trailing evita esto."),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 5: DERIVADOS
        // =============================================
        h1("5. Derivados (Funding Rate, L/S Ratio)"),
        p("Datos del mercado de futuros de Binance:"),

        h2("5.1 Funding Rate"),
        makeTable(["Valor", "Significado"], [
          ["> +0.10%", "PELIGRO: Demasiados longs apalancados. Probable caida."],
          ["+0.05% a +0.10%", "Cautela: Longs elevados"],
          ["-0.05% a +0.05%", "Mercado equilibrado"],
          ["-0.05% a -0.10%", "Oportunidad: Shorts elevados, posible squeeze alcista"],
          ["< -0.10%", "Shorts extremos: Alta probabilidad de rebote explosivo"],
        ], [3000, contentWidth - 3000]),
        tip("El funding rate es una senal CONTRARIA. Cuando todo el mundo esta long (funding alto positivo), es probable que el precio caiga para liquidarlos."),

        h2("5.2 Long/Short Ratio"),
        makeTable(["Valor", "Significado"], [
          ["> 2.0", "Longs abrumadores. Riesgo de liquidacion en cascada."],
          ["1.0 - 2.0", "Sesgo alcista moderado"],
          ["0.67 - 1.0", "Equilibrado"],
          ["< 0.5", "Shorts abrumadores. Riesgo de squeeze alcista."],
        ], [3000, contentWidth - 3000]),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 6: MACRO
        // =============================================
        h1("6. Contexto Macro (BTC Dominance + DXY)"),

        h2("6.1 BTC Dominance"),
        makeTable(["Badge", "Significado", "Que hacer"], [
          ["ALT SEASON (verde)", "BTC dom baja (<45%). Dinero rotando a altcoins.", "Comprar altcoins."],
          ["BTC SEASON (rojo)", "BTC dom alta (>55%). Dinero concentrado en BTC.", "Solo operar BTC. Evitar alts."],
          ["(no aparece)", "Neutral (45-55%)", "Operar normalmente"],
        ], [3000, 4000, contentWidth - 7000]),
        alert("Cuando ves BTC SEASON en rojo, no compres altcoins aunque la senal diga BUY. Las alts caen 2-3x mas que BTC en estas fases."),

        h2("6.2 DXY (Indice del Dolar)"),
        makeTable(["Badge", "Significado", "Que hacer"], [
          ["DXY RISK ON (verde)", "Dolar debil (<98). Dinero fluye a crypto.", "Operar con confianza."],
          ["DXY RISK OFF (rojo)", "Dolar fuerte (>105). Dinero sale de crypto.", "Reducir exposicion."],
          ["(no aparece)", "DXY estable (98-105)", "Operar normalmente"],
        ], [3000, 4000, contentWidth - 7000]),

        h2("6.3 Penalizacion BTC-Altcoin (NUEVO v6.0)"),
        p("Cuando BTC genera senal SELL, las senales de BUY de altcoins reciben una penalizacion automatica de -8 a -12 puntos en su score. Esto previene compras de alts cuando el mercado lider esta bajista."),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 7: FUERZA DE SENAL
        // =============================================
        h1("7. Fuerza de la Senal"),
        makeTable(["Etiqueta", "Score", "Confianza", "Posicion sugerida"], [
          ["STRONG BUY", ">= 50", ">= 60%", "100% de tu tamano normal"],
          ["BUY", ">= 35", ">= 45%", "75% de tu tamano normal"],
          ["WEAK BUY", ">= 25", "< 45%", "50% o menos"],
          ["HOLD", "-25 a +25", "Cualquiera", "No operes. Espera mejor oportunidad."],
          ["WEAK SELL", "<= -15", "< 45%", "Posicion pequena o no vendas"],
          ["SELL", "<= -25", ">= 45%", "75% (short o cierra long)"],
          ["STRONG SELL", "<= -50", ">= 60%", "Cierra posiciones long. Protege capital."],
        ], [2200, 1800, 1800, contentWidth - 5800]),
        p("La confianza maxima esta limitada a 85% (confidence cap). El sistema nunca afirma certeza absoluta.", { italic: true }),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 8: 14 FACTORES
        // =============================================
        h1("8. Los 14 Factores del Motor de Senales"),
        p("Cada senal se genera analizando estos 14 factores:"),
        makeTable(["#", "Factor", "Peso max", "Que analiza"], [
          ["1", "Tendencia EMA", "+/-20", "Direccion de medias moviles 9, 21, 50"],
          ["2", "ADX", "Mult.", "Fuerza de la tendencia (amplifica o reduce)"],
          ["3", "RSI", "+/-18", "Sobrecompra (>70) / sobreventa (<30)"],
          ["4", "MACD", "+/-15", "Momentum y cruces de senal (sin redundancia)"],
          ["5", "Bollinger Bands", "+/-10", "Volatilidad y posicion del precio"],
          ["6", "Soporte/Resistencia", "+/-8", "Niveles clave de precio"],
          ["7", "Divergencias RSI", "+/-20", "Divergencias ocultas (cambios de tendencia)"],
          ["8", "Volumen + OBV", "+/-10", "Confirmacion del movimiento con On-Balance Volume"],
          ["9", "Momentum 24h", "+/-5", "Fuerza del cambio diario"],
          ["10", "Fear & Greed", "+/-3", "Sentimiento extremo (contrarian)"],
          ["11", "Derivados", "+/-15", "Funding rate, OI, L/S ratio"],
          ["12", "BTC Dominance", "+/-10", "Flujo de capital BTC vs Alts"],
          ["13", "DXY Macro", "+/-10", "Fortaleza del dolar (contexto macro global)"],
          ["14", "Order Book", "+/-12", "Presion de compra/venta del libro de ordenes"],
        ], [600, 2500, 1400, contentWidth - 4500]),

        h2("8.1 Mejoras v6.0 en Factores"),
        bullet("MACD: Eliminada redundancia de conteo doble en señales de cruce"),
        bullet("OBV: Scoring mejorado con tendencia de volumen acumulado"),
        bullet("TTL Decay: Cada senal pierde -5% confianza por minuto despues de 5 min"),
        bullet("Regime Multiplier: Senales amplificadas en tendencia, reducidas en rango"),

        h2("8.2 Market Regime Detection (NUEVO v6.0)"),
        p("El sistema detecta automaticamente el regimen de mercado y ajusta las senales:"),
        makeTable(["Regimen", "Condicion", "Efecto en Senales"], [
          ["TRENDING", "ADX > 25, direccion clara", "Senales de tendencia amplificadas"],
          ["RANGING", "ADX < 20, precio lateral", "Senales reducidas, preferir reversal"],
          ["VOLATILE", "ATR alto, movimientos bruscos", "Stops mas amplios, posiciones menores"],
        ], [2000, 3500, contentWidth - 5500]),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 9: PAPER TRADING
        // =============================================
        h1("9. Paper Trading"),
        p("El paper trading simula trades en tiempo real con capital virtual, usando las senales reales del motor."),

        h2("9.1 Configuracion"),
        makeTable(["Parametro", "Default", "Que controla"], [
          ["Capital Inicial", "$10,000", "Monto virtual para simular"],
          ["Riesgo por Trade", "2%", "% del capital arriesgado por operacion (1-2% conservador, 3-5% agresivo)"],
          ["Max Posiciones Abiertas", "5", "Trades simultaneos permitidos"],
          ["Max Perdida Diaria", "5%", "Si se pierde este %, el sistema para automaticamente"],
          ["Confluencia Minima", "3", "Timeframes que deben coincidir para abrir"],
          ["R:R Minimo", "1.5", "Ratio minimo riesgo/recompensa"],
          ["Fuerza Permitida", "STRONG BUY/SELL", "Que senales activan trades"],
          ["Cooldown", "30 min", "Tiempo minimo entre operaciones en el mismo activo"],
        ], [3000, 2000, contentWidth - 5000]),

        h2("9.2 Kelly Criterion - Position Sizing (NUEVO v6.0)"),
        p("El sistema usa el criterio de Kelly para calcular el tamano optimo de cada posicion basado en tu historial de trading:"),
        makeTable(["Parametro Kelly", "Valor", "Descripcion"], [
          ["Fraccion", "0.25 (Quarter-Kelly)", "Conservador: usa solo 25% del Kelly completo"],
          ["Min trades para activar", "20", "Necesita historial minimo para ser confiable"],
          ["Lookback", "100 trades", "Analiza los ultimos 100 trades"],
          ["Min riesgo por trade", "0.5%", "Nunca arriesga menos de esto"],
          ["Max riesgo por trade", "2%", "Nunca arriesga mas de esto"],
        ], [3000, 2500, contentWidth - 5500]),
        tip("El Kelly Criterion ajusta automaticamente tu riesgo: si estas ganando consistentemente, aumenta gradualmente el tamano. Si estas perdiendo, lo reduce para proteger tu capital."),

        h2("9.3 Metricas de Rendimiento"),
        makeTable(["Metrica", "Que mide", "Valor ideal"], [
          ["P&L Total", "Ganancia/perdida acumulada", "Positivo y creciente"],
          ["Win Rate", "% de trades ganadores", "> 50% (idealmente > 55%)"],
          ["Profit Factor", "Ganancias brutas / Perdidas brutas", "> 1.5 (excelente > 2.0)"],
          ["Sharpe Ratio", "Retorno ajustado por riesgo", "> 1.0 bueno, > 2.0 excelente"],
          ["Max Drawdown", "Mayor caida desde un pico de equity", "< 15% (peligro > 20%)"],
          ["Avg Holding Time", "Duracion promedio de un trade", "Depende del estilo"],
        ], [2500, 3500, contentWidth - 6000]),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 10: RISK ENGINE
        // =============================================
        h1("10. Risk Engine y Seguridad (NUEVO v6.0)"),
        p("El Risk Engine es el guardian del sistema. Valida cada trade antes de ejecutarlo y protege tu capital con multiples capas de seguridad."),

        h2("10.1 Validaciones Pre-Trade"),
        p("Antes de abrir cualquier posicion, el sistema verifica 7 condiciones en orden:"),
        makeTable(["#", "Validacion", "Que verifica"], [
          ["1", "Trading habilitado", "Que el trading no este pausado o con kill switch activo"],
          ["2", "Limites de seguridad", "Perdida diaria, cantidad de posiciones, cooldown"],
          ["3", "Trade duplicado", "Solo una posicion abierta por activo"],
          ["4", "Limites de portafolio", "Correlacion, exposicion por sector, posiciones misma direccion"],
          ["5", "Tamano de posicion", "No excede el max % del capital"],
          ["6", "Drawdown Circuit Breaker", "Drawdown rolling de 90 dias no excede umbral"],
          ["7", "Kill Switch", "Verificacion final de emergencia"],
        ], [600, 3000, contentWidth - 3600]),

        h2("10.2 Drawdown Circuit Breaker"),
        p("Monitorea el drawdown en una ventana rolling de 90 dias:"),
        makeTable(["Parametro", "Valor", "Descripcion"], [
          ["Ventana", "90 dias", "Periodo de calculo del drawdown"],
          ["Umbral", "15%", "Si el drawdown supera este %, se bloquean nuevos trades"],
          ["Recuperacion", "Automatica", "Cuando el equity se recupera, se desbloquea"],
          ["Tracking", "Equity snapshots", "Registra el equity diariamente para calculos"],
        ], [2000, 2000, contentWidth - 4000]),

        h2("10.3 Kill Switch (Interruptor de Emergencia)"),
        p("El Kill Switch es un freno de emergencia que puedes activar manualmente:"),
        bullet("Congela inmediatamente la creacion de nuevas ordenes"),
        bullet("Cierra todas las posiciones abiertas (cascading close)"),
        bullet("Registra la activacion en el audit log"),
        bullet("Se desactiva manualmente cuando estimes conveniente"),
        alert("Usa el Kill Switch solo en emergencias: flash crashes, hackeos de exchanges, o cuando detectes comportamiento anomalo."),

        h2("10.4 Limites de Portafolio"),
        makeTable(["Limite", "Valor", "Proposito"], [
          ["Max correlacion", "0.70", "Bloquea entradas correlacionadas (ej: BTC+ETH juntos)"],
          ["Max exposicion sector", "60%", "Evita concentracion excesiva en un sector"],
          ["Max misma direccion", "3 posiciones", "Limita el riesgo direccional"],
          ["Actualizaciones de capital", "Atomicas", "Previene race conditions en capital"],
        ], [3000, 1500, contentWidth - 4500]),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 11: PORTFOLIO MANAGEMENT
        // =============================================
        h1("11. Portfolio Management (APM)"),
        p("El modulo APM (Advanced Portfolio Management) te permite gestionar multiples wallets y ver tu portafolio consolidado."),

        h2("11.1 Wallets Soportados"),
        makeTable(["Tipo", "Proveedores"], [
          ["Exchanges", "Binance, Bybit, Coinbase, Kraken, OKX, Kucoin"],
          ["Exchanges LATAM", "Mercadopago, Skipo, Lemon, Ripio"],
          ["Hot Wallets", "Metamask, Trust Wallet, Phantom, Exodus"],
          ["Cold Storage", "Ledger, Trezor"],
          ["Otro", "Custom (cualquier wallet personalizado)"],
        ], [2500, contentWidth - 2500]),

        h2("11.2 Funcionalidades"),
        bullet("Crear multiples wallets con nombre, color y notas personalizadas"),
        bullet("Cargar holdings via CSV batch upload (valida activos, cantidades, precios, fechas)"),
        bullet("Vista consolidada con precios en tiempo real via CoinGecko"),
        bullet("P&L por activo y por wallet"),
        bullet("Total portfolio value actualizado en tiempo real"),

        h2("11.3 Formato CSV para Upload"),
        makeTable(["Columna", "Obligatoria", "Ejemplo"], [
          ["asset", "Si", "bitcoin, ethereum, solana"],
          ["amount", "Si", "0.5, 10.25"],
          ["buy_price", "Si", "65000, 3200"],
          ["date", "No", "2024-01-15"],
          ["wallet", "No", "binance, ledger"],
        ], [2000, 2000, contentWidth - 4000]),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 12: EXECUTION SYSTEM
        // =============================================
        h1("12. Sistema de Ejecucion"),
        p("El sistema de ordenes maneja el ciclo de vida completo de cada trade:"),

        h2("12.1 Ciclo de Vida de una Orden"),
        makeTable(["Estado", "Significado"], [
          ["PENDING", "Orden creada, esperando validacion del Risk Engine"],
          ["VALIDATED", "Paso todas las validaciones, lista para enviar"],
          ["SUBMITTED", "Enviada al exchange/paper para ejecucion"],
          ["PARTIAL_FILL", "Parcialmente ejecutada en el mercado"],
          ["FILLED", "Completamente ejecutada"],
          ["CANCELLED", "Cancelada por el usuario"],
          ["REJECTED", "Rechazada por el Risk Engine"],
          ["EXPIRED", "Tiempo de validez expirado"],
        ], [2500, contentWidth - 2500]),

        h2("12.2 Adaptadores de Ejecucion"),
        makeTable(["Adaptador", "Uso", "Detalle"], [
          ["Paper", "Simulacion", "Usado en paper trading y backtesting. Sin riesgo real."],
          ["Bybit", "Trading real", "Conecta con Bybit Spot (testnet por defecto para seguridad)."],
        ], [2000, 2000, contentWidth - 4000]),

        h2("12.3 Costos de Ejecucion (Modelo Realista)"),
        p("El backtester y paper trading incluyen costos realistas por activo:"),
        makeTable(["Activo", "Slippage", "Comision"], [
          ["Bitcoin (BTC)", "0.05%", "0.10%"],
          ["Ethereum (ETH)", "0.08%", "0.10%"],
          ["Altcoins mayores", "0.15%", "0.10%"],
          ["Altcoins menores", "0.25%", "0.15%"],
        ], [3000, 3000, contentWidth - 6000]),
        p("Ademas, hay un 2% de probabilidad de gap risk por trade (stop-loss puede ejecutarse hasta 3% peor que el nivel indicado).", { italic: true }),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 13: BACKTESTING
        // =============================================
        h1("13. Backtesting"),
        p("El backtester prueba la estrategia contra datos historicos reales de Binance."),

        h2("13.1 Como Ejecutar un Backtest"),
        numberedItem("Ve a la pestana BACKTEST", "steps2"),
        numberedItem("Selecciona el activo (BTC, ETH, SOL, etc.)", "steps2"),
        numberedItem("Define el periodo de prueba (3-200+ dias)", "steps2"),
        numberedItem("Configura parametros: capital, riesgo, confluencia, R:R", "steps2"),
        numberedItem("Elige el step interval: 4H (menos trades) o 1H (mas trades)", "steps2"),
        numberedItem("Selecciona que senales acepta: STRONG solamente o tambien normales", "steps2"),
        numberedItem("Haz clic en EJECUTAR BACKTEST y espera (barra de progreso)", "steps2"),

        h2("13.2 Metricas del Backtest"),
        makeTable(["Metrica", "Que significa", "Que buscar"], [
          ["Total Trades", "Operaciones ejecutadas", "> 20 para significancia estadistica"],
          ["Win Rate", "% de trades ganadores", "> 50%"],
          ["P&L Total ($)", "Ganancia/perdida total", "Positivo"],
          ["P&L %", "Retorno porcentual", "Mayor que buy-and-hold del activo"],
          ["Max Drawdown %", "Mayor caida desde un pico", "< 15% ideal, > 25% peligroso"],
          ["Profit Factor", "Ganancias / Perdidas", "> 1.5 bueno, > 2.0 excelente"],
          ["Sharpe Ratio", "Retorno ajustado por riesgo", "> 1.0 bueno, > 2.0 excelente"],
        ], [2200, 3200, contentWidth - 5400]),

        h2("13.3 Buy-and-Hold Benchmark (NUEVO v6.0)"),
        p("El backtester ahora incluye automaticamente un benchmark de Buy-and-Hold. Esto muestra cuanto habrias ganado simplemente comprando y manteniendo el activo. Si tu estrategia no supera al B&H, los parametros necesitan ajuste."),

        h2("13.4 Portfolio Backtest (NUEVO v6.0)"),
        p("Ahora puedes ejecutar backtests multi-activo que simulan un portafolio completo con multiples criptomonedas simultaneamente. El portfolio backtest incluye correlacion entre activos y rebalanceo."),

        h2("13.5 Walk-Forward Validation"),
        p("Para evitar overfitting, el optimizador divide los datos en periodos de entrenamiento y prueba:"),
        makeTable(["Datos", "Metodo", "Ventana"], [
          ["< 30 dias", "Single split 70/30", "70% entrenamiento, 30% prueba"],
          [">= 60 dias", "Rolling windows", "20 dias entrenamiento, 10 dias prueba (rolling)"],
        ], [2000, 3000, contentWidth - 5000]),
        p("El parameter stability score mide que tan robusto es un valor a traves de diferentes ventanas."),

        h2("13.6 Monte Carlo Analysis (NUEVO v6.0)"),
        p("Despues de cada backtest, puedes ejecutar un analisis Monte Carlo que:"),
        bullet("Reordena aleatoriamente los trades 1,000 veces (bootstrap)"),
        bullet("Genera intervalos de confianza del 95% para retornos y drawdown"),
        bullet("Muestra la distribucion de caminos posibles"),
        bullet("Identifica el peor escenario probable (5to percentil)"),
        tip("Si el 5to percentil del Monte Carlo es positivo, tu estrategia es robusta. Si es negativo, los resultados dependen del orden de los trades."),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 14: OPTIMIZACION
        // =============================================
        h1("14. Optimizacion de Estrategia"),
        p("El optimizador ejecuta multiples backtests variando parametros para encontrar la configuracion optima."),

        h2("14.1 Parametros Optimizables"),
        makeTable(["Parametro", "Rango", "Que controla"], [
          ["ADX Strong Threshold", "20-40", "Nivel de ADX para tendencia fuerte"],
          ["ADX Strong Multiplier", "1.0-1.6", "Cuanto amplifica en tendencia fuerte"],
          ["RSI Oversold", "20-40", "Nivel de sobreventa (senal de compra)"],
          ["RSI Overbought", "60-80", "Nivel de sobrecompra (senal de venta)"],
          ["Buy Threshold", "15-40", "Puntaje minimo para senal BUY"],
          ["Sell Threshold", "-40 a -15", "Puntaje maximo para senal SELL"],
          ["Trend Score", "10-30", "Peso del factor de tendencia EMA"],
          ["Derivatives Weight", "5-25", "Peso del funding rate y derivados"],
          ["ATR Trailing Mult", "1.5-4.0", "Distancia del trailing stop (ATR)"],
          ["ATR Stop Loss Mult", "1.0-2.5", "Distancia del stop loss (ATR)"],
          ["Confluence Multiplier", "1.0-1.4", "Boost con timeframes alineados"],
          ["Conflicting Multiplier", "0.5-0.9", "Reduccion con timeframes en conflicto"],
          ["Order Book Weight", "5-20", "Peso del order book en score"],
          ["Confidence Cap", "70-95", "Maximo de confianza permitido"],
          ["Risk Per Trade", "1%-5%", "% de capital arriesgado por operacion"],
        ], [3500, 1800, contentWidth - 5300]),

        h2("14.2 Auto-Tuner (NUEVO v6.0)"),
        p("El Auto-Tuner optimiza parametros automaticamente y pide aprobacion via Telegram:"),
        numberedItem("Ejecuta optimizacion sobre 60 dias de datos historicos", "steps3"),
        numberedItem("Selecciona los 5 parametros de mayor impacto", "steps3"),
        numberedItem("Aplica blend 50% entre valor actual y optimo (cambio gradual)", "steps3"),
        numberedItem("Envia propuesta de cambio via Telegram para aprobacion", "steps3"),
        numberedItem("Si se aprueba, aplica los cambios y monitorea rendimiento", "steps3"),
        numberedItem("Si el rendimiento cae >20%, revierte automaticamente", "steps3"),
        alert("Cuidado con el overfitting: si un parametro solo funciona en un periodo especifico, probablemente no funcionara en el futuro."),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 15: ALERTAS
        // =============================================
        h1("15. Filtros Personalizados de Alertas"),
        p("Configura exactamente que alertas quieres recibir y por que canal."),
        makeTable(["Filtro", "Opciones", "Para que sirve"], [
          ["Activos", "Selecciona uno o varios", "Solo alertas de activos que te interesan"],
          ["Tipos de senal", "BUY, SELL, STRONG BUY, STRONG SELL", "Filtrar por tipo de accion"],
          ["Confianza minima", "0-100% (slider)", "Ignorar senales con confianza baja. Recomendado: >= 50%"],
          ["Score minimo", "0-100 (slider)", "Ignorar senales con puntaje bajo. Recomendado: >= 25"],
          ["Cooldown", "5-120 minutos", "Tiempo minimo entre alertas del mismo activo"],
          ["Canal: Telegram", "On/Off", "Recibir alertas por Telegram"],
          ["Canal: Email", "On/Off", "Recibir alertas por email"],
          ["Master switch", "On/Off", "Activa/desactiva todas las alertas"],
        ], [2500, 2800, contentWidth - 5300]),

        h2("15.1 Filtros Avanzados con Condiciones"),
        p("Puedes crear filtros avanzados basados en condiciones logicas:"),
        makeTable(["Campo", "Operadores", "Ejemplo"], [
          ["score", "> , < , >= , <=", "score > 75 (solo senales con score alto)"],
          ["confidence", "> , < , >= , <=", "confidence >= 60 (alta confianza)"],
          ["strength", "= , !=", "strength = STRONG BUY"],
          ["action", "= , !=", "action != HOLD (excluir holds)"],
          ["asset", "= , in", "asset in bitcoin,ethereum"],
          ["riskReward", "> , >= , <", "riskReward >= 2.0"],
          ["confluence", "= , >=", "confluence >= 2"],
        ], [2000, 2200, contentWidth - 4200]),
        tip("Para empezar: confianza >= 60%, solo STRONG BUY/SELL, cooldown 30 min. Pocas alertas de alta calidad."),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 16: DASHBOARD
        // =============================================
        h1("16. Dashboard y Analytics"),
        p("El dashboard es tu centro de control con informacion en tiempo real."),

        h2("16.1 Seccion Macro"),
        makeTable(["Indicador", "Que es", "Como leerlo"], [
          ["Fear & Greed", "Sentimiento del mercado (0-100)", "< 25 = miedo extremo (oportunidad). > 75 = codicia (precaucion)."],
          ["BTC Dominance", "% del mercado que es BTC", "> 55% = BTC season. < 45% = alt season."],
          ["DXY (Dollar)", "Indice de fuerza del dolar", "Rising = bearish crypto. Falling = bullish crypto."],
          ["Total Market Cap", "Capitalizacion total crypto", "Tendencia general del mercado"],
        ], [2200, 3200, contentWidth - 5400]),

        h2("16.2 Graficos de Analytics"),
        makeTable(["Grafico", "Datos", "Cuando aparece"], [
          ["Curva de Equity (Paper)", "Progresion del capital desde trades cerrados", "Con al menos 2 trades cerrados"],
          ["P&L Diario", "Ganancia/perdida agrupada por dia (barras verdes/rojas)", "Con trades cerrados"],
          ["Rendimiento por Activo", "Wins vs Losses por cada criptomoneda", "Con trades cerrados"],
          ["Backtest Equity Curve", "Curva del ultimo backtest con % de retorno", "Con backtest completado"],
        ], [2500, 3500, contentWidth - 6000]),

        h2("16.3 11 Pestanas del Sistema"),
        makeTable(["Pestana", "Funcion"], [
          ["Dashboard", "Vista general: macro, senales top, salud del sistema"],
          ["Signals", "Tabla de senales en tiempo real con todos los detalles"],
          ["Alerts", "Historial de alertas y configuracion de filtros"],
          ["APM", "Gestion avanzada de portafolio multi-wallet"],
          ["Portfolio", "Upload CSV, gestionar wallets, tracking de posiciones"],
          ["Execution", "Creacion de ordenes, risk dashboard, kill switch, audit log"],
          ["Strategy", "Editor de configuracion, ajuste de parametros en vivo"],
          ["Backtest", "Tests historicos (single y portfolio), metricas, comparacion"],
          ["Optimize", "Grid search con walk-forward validation"],
          ["Reports", "Analisis de rendimiento, equity curves, distribucion de trades"],
          ["Guide", "Documentacion del usuario, explicaciones, quick start"],
        ], [2000, contentWidth - 2000]),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 17: GUIA DE USO (NUEVA)
        // =============================================
        h1("17. Guia de Uso: Pasos para Mejores Resultados"),
        p("Sigue esta guia paso a paso para sacar el maximo provecho de Sentix Pro y obtener mejores resultados de trading."),

        h2("Fase 1: Configuracion Inicial (Dia 1)"),
        h3("Paso 1: Conoce el Dashboard"),
        bullet("Familiarizate con las secciones macro: Fear & Greed, BTC Dominance, DXY"),
        bullet("Observa como cambian las senales cada 5 minutos"),
        bullet("Lee la pestana Guide completa para entender cada indicador"),

        h3("Paso 2: Configura tus Alertas"),
        bullet("Ve a Alerts y configura filtros iniciales conservadores:"),
        bullet("Confianza minima: 60%", "bullets2"),
        bullet("Solo STRONG BUY y STRONG SELL", "bullets2"),
        bullet("Cooldown: 30 minutos", "bullets2"),
        bullet("Activa Telegram y/o Email para recibir notificaciones"),

        h3("Paso 3: Configura Paper Trading"),
        bullet("Capital inicial: usa tu capital real planeado (ej: $10,000)"),
        bullet("Riesgo por trade: 2% (conservador para empezar)"),
        bullet("Max posiciones: 3 (menos posiciones = menor riesgo)"),
        bullet("Confluencia minima: 3 (solo senales con todos los TFs alineados)"),
        bullet("Senales: solo STRONG BUY/SELL (maxima calidad)"),

        h2("Fase 2: Validacion en Paper Trading (Semanas 1-4)"),
        h3("Paso 4: Opera en Paper 2-4 Semanas"),
        bullet("Activa el paper trading automatico"),
        bullet("NO cambies los parametros durante las primeras 2 semanas"),
        bullet("Revisa diariamente: Win Rate, P&L, Max Drawdown"),
        bullet("Objetivo minimo: Win Rate > 50%, Profit Factor > 1.2"),

        h3("Paso 5: Analiza tus Resultados"),
        bullet("Revisa los graficos del Dashboard: Equity Curve, P&L Diario"),
        bullet("Identifica en que activos funciona mejor tu estrategia"),
        bullet("Anota los patrones: funcionan mejor las senales de manana o tarde? Que activos pierden mas?"),

        h2("Fase 3: Optimizacion (Semanas 3-4)"),
        h3("Paso 6: Ejecuta Backtests"),
        bullet("Backtest con 90 dias minimo para resultados significativos"),
        bullet("Prueba con BTC primero (el activo mas liquido y predecible)"),
        bullet("Compara tu Sharpe vs el benchmark Buy-and-Hold"),
        bullet("Si Sharpe < 1.0, los parametros necesitan ajuste"),

        h3("Paso 7: Optimiza Parametros Clave"),
        p("Optimiza estos parametros en este orden (de mayor a menor impacto):"),
        numberedItem("buyThreshold / sellThreshold (umbrales de entrada)", "steps4"),
        numberedItem("atrTrailingMult / atrStopLossMult (gestion de riesgo por trade)", "steps4"),
        numberedItem("rsiOversold / rsiOverbought (sensibilidad del RSI)", "steps4"),
        numberedItem("confluenceMultiplier (bonus por alineacion de TFs)", "steps4"),
        numberedItem("riskPerTrade (tamano de posicion)", "steps4"),
        tip("Optimiza UN parametro a la vez. Fija el mejor valor y pasa al siguiente."),

        h3("Paso 8: Valida con Monte Carlo"),
        bullet("Ejecuta analisis Monte Carlo en tus mejores backtests"),
        bullet("Verifica que el 5to percentil sea positivo (estrategia robusta)"),
        bullet("Si el rango 5-95% es muy amplio, la estrategia es inestable"),

        h2("Fase 4: Trading Real (Mes 2+)"),
        h3("Paso 9: Prepara tu Portafolio"),
        bullet("Configura tus wallets en la pestana APM"),
        bullet("Carga tus holdings actuales via CSV"),
        bullet("Establece tu capital de trading (solo lo que puedes perder)"),

        h3("Paso 10: Opera con Disciplina"),
        p("Reglas de oro para trading real:"),
        numberedItem("Nunca operes sin stop-loss", "steps5"),
        numberedItem("Siempre toma al menos 50% de ganancias en TP1", "steps5"),
        numberedItem("No operes senales con confianza < 50%", "steps5"),
        numberedItem("No operes alts cuando BTC SEASON esta activo", "steps5"),
        numberedItem("Si pierdes 3 trades seguidos, para y analiza", "steps5"),
        numberedItem("Revisa el Risk Dashboard antes de cada trade", "steps5"),
        numberedItem("Usa el Kill Switch si algo no se ve bien", "steps5"),

        h2("Fase 5: Mejora Continua"),
        h3("Paso 11: Ajuste Mensual"),
        bullet("Cada mes, ejecuta un backtest de los ultimos 90 dias"),
        bullet("Compara con el mes anterior: mejoro o empeoro?"),
        bullet("Re-optimiza los parametros top 3 si el Sharpe cae < 1.0"),
        bullet("Activa el Auto-Tuner para ajustes automaticos con aprobacion Telegram"),

        h3("Paso 12: Escala Gradualmente"),
        bullet("Empieza con posiciones pequenas (1% riesgo)"),
        bullet("Solo aumenta riesgo despues de 20+ trades rentables"),
        bullet("Maximo recomendado: 2% por trade para cuentas < $50K"),
        bullet("Diversifica: no pongas mas del 60% en un solo activo"),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 18: PARAMETROS RECOMENDADOS
        // =============================================
        h1("18. Parametros Recomendados por Perfil"),

        h2("18.1 Perfil Conservador (principiante)"),
        makeTable(["Parametro", "Valor", "Razon"], [
          ["Riesgo por trade", "1%", "Minimiza perdidas mientras aprendes"],
          ["Max posiciones", "2", "Menos posiciones = menor riesgo total"],
          ["Confluencia minima", "3", "Solo opera con todos los TFs alineados"],
          ["Senales", "Solo STRONG", "Maxima calidad de senales"],
          ["Cooldown", "60 min", "Evita sobre-operar"],
          ["Confianza minima", "60%", "Solo senales de alta conviccion"],
          ["Kelly Criterion", "Desactivado", "Riesgo fijo hasta tener historial"],
          ["Max drawdown", "10%", "Para rapidamente si hay perdidas"],
        ], [2800, 1800, contentWidth - 4600]),

        h2("18.2 Perfil Moderado (intermedio)"),
        makeTable(["Parametro", "Valor", "Razon"], [
          ["Riesgo por trade", "2%", "Balance entre crecimiento y seguridad"],
          ["Max posiciones", "3-4", "Diversificacion moderada"],
          ["Confluencia minima", "2", "Mas oportunidades de trading"],
          ["Senales", "STRONG + BUY/SELL", "Mayor frecuencia de trades"],
          ["Cooldown", "30 min", "Equilibrio entre oportunidades y spam"],
          ["Confianza minima", "50%", "Acepta senales con conviccion decente"],
          ["Kelly Criterion", "Quarter Kelly (0.25)", "Position sizing adaptativo"],
          ["Max drawdown", "15%", "Estandar de la industria"],
        ], [2800, 2500, contentWidth - 5300]),

        h2("18.3 Perfil Agresivo (avanzado)"),
        makeTable(["Parametro", "Valor", "Razon"], [
          ["Riesgo por trade", "3-5%", "Mayor rendimiento potencial, mayor riesgo"],
          ["Max posiciones", "5", "Maximo diversificacion"],
          ["Confluencia minima", "2", "Mas oportunidades"],
          ["Senales", "Todas incluyendo WEAK", "Maxima frecuencia"],
          ["Cooldown", "15 min", "Mas trades posibles"],
          ["Confianza minima", "40%", "Acepta senales con conviccion moderada"],
          ["Kelly Criterion", "Half Kelly (0.50)", "Sizing agresivo pero controlado"],
          ["Max drawdown", "20%", "Mayor tolerancia a perdidas"],
        ], [2800, 2500, contentWidth - 5300]),
        alert("El perfil agresivo requiere experiencia y capital que puedas permitirte perder. No uses este perfil si eres nuevo en trading."),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 19: FLUJO DE DECISION
        // =============================================
        h1("19. Flujo de Decision para Operar"),
        p("Sigue este proceso antes de cada trade:"),
        numberedItem("PASO 1 - Mira la ACCION: HOLD? -> NO OPERES. BUY/SELL? -> Continua...", "steps6"),
        numberedItem("PASO 2 - Verifica CONFLUENCIA: Conflicto? -> NO OPERES. Moderada? -> 50% posicion. Fuerte? -> Continua.", "steps6"),
        numberedItem("PASO 3 - Revisa R:R: < 1.5? -> NO OPERES. >= 1.5? -> Continua.", "steps6"),
        numberedItem("PASO 4 - Chequea DERIVADOS: Funding extremo contra tu direccion? -> Cuidado. Normal? -> Continua.", "steps6"),
        numberedItem("PASO 5 - Revisa ORDER BOOK: Presion contraria? -> Reduce posicion. A favor? -> Confirma.", "steps6"),
        numberedItem("PASO 6 - Revisa MACRO: BTC SEASON + operando alt? -> NO COMPRES. DXY RISK OFF? -> Reduce.", "steps6"),
        numberedItem("PASO 7 - VERIFICA TTL: Senal > 10 min? -> Espera nueva senal. < 5 min? -> Optimo.", "steps6"),
        numberedItem("PASO 8 - EJECUTA: Entrada + Stop Loss inmediato + TP1 (50%) + Trailing Stop + TP2 (50% restante).", "steps6"),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 20: ERRORES COMUNES
        // =============================================
        h1("20. Errores Comunes a Evitar"),
        makeTable(["Error", "Por que es peligroso", "Que hacer"], [
          ["Operar sin stop-loss", "Una sola caida puede destruir tu cuenta", "Siempre usa el SL de la senal"],
          ["Ignorar R:R < 1.5", "Arriesgas mas de lo que puedes ganar", "Si es rojo, no operes"],
          ["Comprar alts en BTC SEASON", "Las alts caen 2-3x mas que BTC", "Solo opera BTC con badge rojo"],
          ["Ignorar confluencia en conflicto", "Los timeframes se contradicen", "Espera a que se alineen"],
          ["No tomar ganancias en TP1", "El precio puede devolverse", "Siempre vende al menos 50% en TP1"],
          ["WEAK BUY como STRONG", "Fiabilidad muy diferente", "Reduce posicion o espera mejor senal"],
          ["Ignorar funding rate extremo", "Liquidaciones causan crashes", "Si funding > 0.10%, no compres"],
          ["No hacer backtest", "Operas a ciegas", "Backtest antes de dinero real"],
          ["Ignorar order book", "Operas contra presion de mercado", "Si BEARISH, cuidado con BUY"],
          ["Trading real sin paper", "No sabes si funciona", "Valida 2-4 semanas en paper"],
          ["Operar senales expiradas", "Condiciones ya cambiaron", "Solo opera senales < 10 min"],
          ["No usar Kill Switch en emergencia", "Perdidas se acumulan", "Activa si algo esta mal"],
          ["Over-optimizar parametros", "Overfitting a datos pasados", "Valida con Monte Carlo"],
        ], [3000, 3000, contentWidth - 6000]),

        new Paragraph({ children: [new PageBreak()] }),

        // =============================================
        // SECTION 21: GLOSARIO
        // =============================================
        h1("21. Glosario"),
        makeTable(["Termino", "Significado"], [
          ["ATR", "Average True Range. Mide la volatilidad tipica del activo."],
          ["RSI", "Relative Strength Index. Sobrecompra (>70) y sobreventa (<30)."],
          ["MACD", "Indicador de momentum. Cruces indican cambios de tendencia."],
          ["EMA", "Media movil exponencial. 9 > 21 > 50 = tendencia alcista."],
          ["OBV", "On-Balance Volume. Tendencia de volumen acumulado para confirmar movimientos."],
          ["Bollinger Bands", "Bandas de volatilidad. Precio fuera = movimiento extremo."],
          ["ADX", "Mide fuerza de tendencia. > 30 = fuerte. < 20 = sin tendencia."],
          ["Ichimoku", "Sistema de 5 lineas para tendencia, soporte y resistencia."],
          ["VWAP", "Volume Weighted Average Price. Precio promedio ponderado por volumen."],
          ["Funding Rate", "Tasa que pagan longs a shorts cada 8 horas en futuros."],
          ["OI", "Open Interest. Total de posiciones abiertas en futuros."],
          ["L/S Ratio", "Proporcion de longs vs shorts en el mercado."],
          ["DXY", "Indice del dolar americano contra canasta de monedas."],
          ["Trailing Stop", "Stop-loss que se mueve automaticamente a tu favor."],
          ["R:R", "Risk/Reward. Cuanto puedes ganar vs cuanto puedes perder."],
          ["Confluence", "Cuando multiples timeframes estan de acuerdo."],
          ["Order Book", "Libro de ordenes de compra/venta pendientes."],
          ["Imbalance", "Desbalance entre ordenes de compra y venta."],
          ["Paper Trading", "Simulacion de trading con capital virtual."],
          ["Backtesting", "Prueba de estrategia contra datos historicos."],
          ["Walk-Forward", "Validacion que divide datos en periodos de entrenamiento y prueba."],
          ["Monte Carlo", "Analisis estadistico que reordena trades para medir robustez."],
          ["Grid Search", "Metodo de optimizacion que prueba todas las combinaciones."],
          ["Sharpe Ratio", "Retorno ajustado por riesgo. > 1 bueno, > 2 excelente."],
          ["Profit Factor", "Ganancias brutas dividido perdidas brutas. > 1.5 bueno."],
          ["Max Drawdown", "Mayor caida porcentual desde un pico de equity."],
          ["Kelly Criterion", "Formula matematica para calcular el tamano optimo de posicion."],
          ["Kill Switch", "Interruptor de emergencia que detiene todo el trading."],
          ["Circuit Breaker", "Mecanismo automatico que bloquea trading cuando drawdown excede umbral."],
          ["TTL", "Time-to-Live. Tiempo de validez de una senal antes de expirar."],
          ["Market Regime", "Estado del mercado: trending, ranging o volatile."],
          ["Auto-Tuner", "Sistema que optimiza parametros automaticamente con aprobacion Telegram."],
          ["APM", "Advanced Portfolio Management. Gestion avanzada de portafolio multi-wallet."],
          ["SSE", "Server-Sent Events. Streaming de datos en tiempo real al navegador."],
          ["Cooldown", "Tiempo minimo entre alertas o trades del mismo activo."],
          ["Overfitting", "Cuando parametros se ajustan demasiado a datos pasados."],
        ], [2500, contentWidth - 2500]),

        new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Sentix Pro v6.0 - Motor de 14 factores con analisis multi-timeframe, order book, derivados, contexto macro, paper trading, backtesting, optimizacion, portfolio management, risk engine, Kelly criterion y Monte Carlo.", size: 18, font: "Arial", color: gray, italics: true })] }),
      ]
    }
  ]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("GUIA_SENTIX_PRO_v6.docx", buffer);
  console.log("Document created: GUIA_SENTIX_PRO_v6.docx");
  console.log("Size:", (buffer.length / 1024).toFixed(1), "KB");
});
