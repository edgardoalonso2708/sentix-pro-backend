# SENTIX PRO - Guia Completa de Senales de Trading

## Que es Sentix Pro?

Sentix Pro es un motor de senales de trading que analiza 13 factores tecnicos, derivados y macroeconomicos para generar senales accionables de BUY (comprar), SELL (vender) o HOLD (esperar). Cada senal incluye niveles exactos de entrada, salida, stop-loss y trailing stop.

---

## 1. Anatomia de una Senal

Cada tarjeta de senal muestra esta informacion de arriba a abajo:

### Encabezado
| Elemento | Significado |
|----------|-------------|
| Emoji verde + nombre | Senal de COMPRA |
| Emoji rojo + nombre | Senal de VENTA |
| Emoji blanco + nombre | HOLD (esperar) |
| Precio actual | Ultimo precio del activo |
| % 24h | Cambio de precio en las ultimas 24 horas |

### Badges (esquina superior derecha)
| Badge | Significado |
|-------|-------------|
| **CONFLUENCIA FUERTE** (verde) | Los 3 timeframes (4H, 1H, 15M) estan de acuerdo |
| **CONFLUENCIA MODERADA** (amarillo) | 2 de 3 timeframes de acuerdo |
| **CONFLICTO** (rojo) | Los timeframes se contradicen |
| **BUY / SELL / HOLD** | La accion recomendada |
| **X% confianza** | Que tan seguro esta el motor de la senal |
| **Score X/100** | Puntaje general de la senal |

---

## 2. Barra de Timeframes (4H / 1H / 15M)

Tres bloques que muestran que dice cada temporalidad:

| Timeframe | Peso | Que representa |
|-----------|------|----------------|
| **4H** (40%) | Tendencia macro | La direccion del mercado en las ultimas horas. Si es bajista, ten cuidado aunque 1H diga compra. |
| **1H** (40%) | Senal principal | El timeframe donde se genera la senal de trading. |
| **15M** (20%) | Timing de entrada | Confirma si el momento exacto es bueno para entrar. |

### Como interpretarlo:
- **3/3 de acuerdo (verde)**: Alta probabilidad. Todas las temporalidades apuntan en la misma direccion.
- **2/3 de acuerdo (amarillo)**: Probabilidad moderada. Entra con menor posicion.
- **Conflicto (rojo)**: El mercado esta indeciso. **No operes** hasta que se aclare.

**Regla de oro**: El 4H es el "gobernador". Si el 4H dice SELL pero 1H y 15M dicen BUY, la senal se debilita automaticamente. Nunca vayas contra la tendencia macro.

---

## 3. Niveles de Operacion (Trade Levels)

Este panel solo aparece en senales de BUY o SELL (no en HOLD):

| Nivel | Color | Que significa |
|-------|-------|---------------|
| **ENTRADA** | Blanco | Precio al que deberias entrar |
| **STOP LOSS** | Rojo | Precio maximo de perdida. Si llega aqui, vende para proteger tu capital. |
| **TP1** | Verde | Primer objetivo de ganancia. Toma al menos 50% de tu posicion aqui. |
| **TP2** | Verde | Segundo objetivo (mas ambicioso). Deja correr el resto hasta aqui. |
| **TRAILING STOP** | Amarillo | Stop dinamico que sube con el precio para proteger ganancias. |
| **ACTIVA EN** | Blanco | Precio donde se activa el trailing stop (cuando ya tienes ganancia). |
| **R:R** | Verde/Rojo | Ratio riesgo/recompensa. Verde si >= 1.5, rojo si menor. |

### Como usar los niveles paso a paso:

**Para una senal de BUY:**
1. Coloca tu orden de compra en el precio de **ENTRADA**
2. Inmediatamente coloca un stop-loss en **STOP LOSS** (proteccion obligatoria)
3. Cuando el precio suba a **TP1**, vende el 50% de tu posicion (asegura ganancia)
4. Activa el **TRAILING STOP** cuando el precio alcance el nivel de activacion
5. Deja el 50% restante correr hacia **TP2** con el trailing protegiendote

**Para una senal de SELL:**
- Mismo proceso pero invertido (vendes/shorteas en entrada, SL arriba, TP abajo)

### Ratio Riesgo/Recompensa (R:R)

| R:R | Interpretacion | Accion |
|-----|----------------|--------|
| >= 2.5 | Excelente | Operar con posicion completa |
| >= 1.5 | Aceptable | Operar normalmente |
| < 1.5 (rojo) | **Peligroso** | **NO operes**. Arriesgas mas de lo que puedes ganar. |

**Ejemplo**: Si tu stop-loss esta a 2% de distancia y tu TP1 a 5%, tu R:R es 2.5:1. Esto significa que por cada dolar que arriesgas, puedes ganar $2.50.

---

## 4. Trailing Stop - Tu Protector de Ganancias

El trailing stop es un stop-loss que se mueve automaticamente a tu favor:

| Concepto | Detalle |
|----------|---------|
| **Distancia inicial** | 2.5 x ATR (mas ancho que acciones por la volatilidad crypto) |
| **Se activa cuando** | Tu trade tiene 1 ATR de ganancia |
| **Paso** | Sube 1 ATR cada vez que el precio avanza |

**Ejemplo practico (BUY en Bitcoin a $100,000):**
- ATR = $2,000
- Trailing stop inicial: $95,000 (100,000 - 2.5 x 2,000)
- Se activa en: $102,000 (ganancia de 1 ATR)
- Cuando BTC sube a $104,000, el trailing sube a $99,000
- Cuando BTC sube a $108,000, el trailing sube a $103,000
- Si BTC cae a $103,000, vendes con ganancia de $3,000 (en vez de perder)

**Sin trailing stop**: Muchos traders ven +20% de ganancia y luego el precio se devuelve a 0%. El trailing evita esto.

---

## 5. Derivados (Funding Rate, L/S Ratio)

Esta fila muestra datos del mercado de futuros de Binance:

### Funding Rate
| Valor | Color | Significado |
|-------|-------|-------------|
| > +0.10% | Rojo | **Peligro**: Demasiados longs apalancados. Probable caida. |
| +0.05% a +0.10% | Rojo | Cautela: Longs elevados |
| -0.05% a +0.05% | Normal | Mercado equilibrado |
| -0.05% a -0.10% | Verde | Oportunidad: Shorts elevados, posible squeeze alcista |
| < -0.10% | Verde | **Shorts extremos**: Alta probabilidad de rebote explosivo |

**Interpretacion clave**: El funding rate es una senal **contraria**. Cuando todo el mundo esta long (funding alto positivo), es probable que el precio caiga para liquidarlos. Y viceversa.

### Long/Short Ratio
| Valor | Significado |
|-------|-------------|
| > 2.0 | Longs abrumadores. Riesgo de liquidacion en cascada hacia abajo. |
| 1.0 - 2.0 | Sesgo alcista moderado |
| 0.67 - 1.0 | Equilibrado |
| < 0.5 | Shorts abrumadores. Riesgo de squeeze alcista. |

### Sentimiento
| Etiqueta | Significado |
|----------|-------------|
| OVER LEVERAGED LONG | Exceso de apalancamiento alcista. **Cuidado con comprar.** |
| OVER LEVERAGED SHORT | Exceso de apalancamiento bajista. **Oportunidad de compra.** |
| NEUTRAL | Posicionamiento equilibrado |

---

## 6. Contexto Macro (BTC Dominance + DXY)

### BTC Dominance (Dominancia de Bitcoin)

| Badge | Color | Significado | Que hacer |
|-------|-------|-------------|-----------|
| **ALT SEASON** | Verde | BTC dominancia baja (<45%). Dinero rotando a altcoins. | Comprar altcoins. |
| **BTC SEASON** | Rojo | BTC dominancia alta (>55%). Dinero concentrado en BTC. | Solo operar BTC. Evitar alts. |
| (no aparece) | - | Neutral (45-55%) | Operar normalmente |

**Regla critica**: Cuando ves "BTC SEASON" en rojo, **no compres altcoins** aunque la senal diga BUY. Las alts caen 2-3x mas que BTC en estas fases.

### DXY (Indice del Dolar)

| Badge | Color | Significado | Que hacer |
|-------|-------|-------------|-----------|
| **DXY RISK ON** | Verde | Dolar debil y cayendo. Dinero fluye a crypto. | Operar con confianza. Macro a favor. |
| **DXY RISK OFF** | Rojo | Dolar fuerte y subiendo. Dinero sale de crypto. | Reducir exposicion. Macro en contra. |
| (no aparece) | - | DXY estable | Operar normalmente |

**Dato clave**: La correlacion inversa entre DXY y crypto es de ~85%. Cuando el dolar sube fuerte, crypto baja. No hay excepcion.

---

## 7. Fuerza de la Senal - Que tan en serio tomarla

| Etiqueta | Score | Confianza | Posicion sugerida |
|----------|-------|-----------|-------------------|
| **STRONG BUY** | >= 75 | >= 60% | 100% de tu tamano normal |
| **BUY** | >= 67 | >= 45% | 75% de tu tamano normal |
| **WEAK BUY** | >= 62 | < 45% | 50% o menos. Solo si otros factores ayudan. |
| **HOLD** | 38-62 | Cualquiera | **No operes.** Espera mejor oportunidad. |
| **WEAK SELL** | <= 38 | < 45% | Posicion pequena o simplemente no compres. |
| **SELL** | <= 33 | >= 45% | 75% de tu tamano normal (short o cierra long) |
| **STRONG SELL** | <= 25 | >= 60% | Cierra posiciones long. Protege capital. |

---

## 8. Los 13 Factores del Motor de Senales

Cada senal se genera analizando estos 13 factores en orden:

| # | Factor | Peso max | Que analiza |
|---|--------|----------|-------------|
| 1 | **Tendencia EMA** | +/-20 | Direccion de medias moviles 9, 21, 50 |
| 2 | **ADX** | Multiplicador | Fuerza de la tendencia (amplifica o reduce otros factores) |
| 3 | **RSI** | +/-18 | Sobrecompra/sobreventa |
| 4 | **MACD** | +/-15 | Momentum y cruces de senal |
| 5 | **Bollinger Bands** | +/-10 | Volatilidad y posicion del precio |
| 6 | **Soporte/Resistencia** | +/-8 | Niveles clave de precio |
| 7 | **Divergencias RSI** | +/-20 | Divergencias ocultas (cambios de tendencia antes de que ocurran) |
| 8 | **Volumen** | +/-10 | Confirmacion o negacion del movimiento |
| 9 | **Momentum 24h** | +/-10 | Fuerza del cambio diario |
| 10 | **Fear & Greed** | +/-3 | Sentimiento extremo del mercado (contrarian) |
| 11 | **Derivados** | +/-15 | Funding rate, OI, L/S ratio de futuros |
| 12 | **BTC Dominance** | +/-10 | Flujo de capital BTC vs Alts |
| 13 | **DXY Macro** | +/-10 | Fortaleza del dolar (contexto macro global) |

---

## 9. Dashboard - Seccion Macro

En el dashboard principal veras estas estadisticas:

| Indicador | Que es | Como leerlo |
|-----------|--------|-------------|
| **Fear & Greed** | Sentimiento del mercado (0-100) | < 25 = miedo extremo (oportunidad). > 75 = codicia extrema (precaucion). |
| **BTC Dominance** | % del mercado total que es Bitcoin | > 55% = BTC season. < 45% = alt season. |
| **DXY (Dollar)** | Indice de fuerza del dolar | Rising = bearish crypto. Falling = bullish crypto. |
| **Total Market Cap** | Capitalizacion total del mercado crypto | Tendencia general del mercado |
| **Gold / Silver** | Precios de metales preciosos | Refugios de valor. Si suben junto con crypto, el movimiento es mas fuerte. |

---

## 10. Flujo de Decision para Operar

Sigue este proceso antes de cada trade:

```
1. Mira la ACCION (BUY/SELL/HOLD)
   |
   HOLD? --> NO OPERES. Espera.
   |
   BUY o SELL? --> Continua...

2. Verifica CONFLUENCIA
   |
   Conflicto/Debil? --> NO OPERES
   |
   Moderada? --> Reduce tamano de posicion a 50%
   |
   Fuerte? --> Posicion normal. Continua...

3. Revisa R:R (Riesgo/Recompensa)
   |
   < 1.5? --> NO OPERES. No vale la pena.
   |
   >= 1.5? --> Continua...

4. Chequea DERIVADOS
   |
   Funding > +0.10%? --> Cuidado con BUY (mercado sobrecalentado)
   |
   Funding < -0.10%? --> Cuidado con SELL (posible squeeze)
   |
   Normal? --> Continua...

5. Revisa MACRO
   |
   BTC SEASON + operando alt? --> NO COMPRES la alt
   |
   DXY RISK OFF? --> Reduce exposicion general
   |
   Todo OK? --> Continua...

6. EJECUTA
   - Compra/vende en precio de ENTRADA
   - Coloca STOP LOSS inmediatamente
   - Programa TP1 (vende 50%)
   - Activa TRAILING STOP en el nivel indicado
   - Deja correr el resto hacia TP2
```

---

## 11. Errores Comunes a Evitar

| Error | Por que es peligroso | Que hacer |
|-------|---------------------|-----------|
| Operar sin stop-loss | Una sola caida puede destruir tu cuenta | **Siempre** usa el SL que indica la senal |
| Ignorar R:R < 1.5 | Arriesgas mas de lo que puedes ganar | Si es rojo, no operes |
| Comprar alts en BTC SEASON | Las alts caen 2-3x mas que BTC | Solo opera BTC cuando ves el badge rojo |
| Ignorar confluencia en conflicto | Los timeframes se contradicen | Espera a que se alineen |
| No tomar ganancias en TP1 | El precio puede devolverse a 0% | Siempre vende al menos 50% en TP1 |
| Operar con WEAK BUY como si fuera STRONG | Son senales muy diferentes en fiabilidad | Reduce posicion o espera mejor senal |
| Ignorar el funding rate extremo | Las liquidaciones masivas causan crashes | Si funding > 0.10%, no compres |

---

## 12. Glosario Rapido

| Termino | Significado |
|---------|-------------|
| **ATR** | Average True Range. Mide la volatilidad tipica del activo. |
| **RSI** | Relative Strength Index. Mide sobrecompra (>70) y sobreventa (<30). |
| **MACD** | Indicador de momentum. Cruces indican cambios de tendencia. |
| **EMA** | Media movil exponencial. Cuando 9 > 21 > 50 = tendencia alcista. |
| **Bollinger Bands** | Bandas de volatilidad. Precio fuera = movimiento extremo. |
| **ADX** | Mide fuerza de tendencia. > 30 = tendencia fuerte. < 20 = sin tendencia. |
| **Funding Rate** | Tasa que pagan longs a shorts (o viceversa) cada 8 horas. |
| **OI** | Open Interest. Total de posiciones abiertas en futuros. |
| **L/S Ratio** | Proporcion de longs vs shorts en el mercado. |
| **DXY** | Indice del dolar americano contra una canasta de monedas. |
| **Trailing Stop** | Stop-loss que se mueve automaticamente a tu favor. |
| **R:R** | Risk/Reward. Cuanto puedes ganar vs cuanto puedes perder. |
| **Confluence** | Cuando multiples timeframes estan de acuerdo en la direccion. |

---

*Sentix Pro v4.5 - Motor de 13 factores con analisis multi-timeframe, niveles de operacion, derivados y contexto macro.*
