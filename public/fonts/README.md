# Font files

## Already bundled ✓

| File | Font | Source |
|---|---|---|
| `IbarraRealNova-{Regular,Bold,Italic,BoldItalic}.ttf` | Ibarra Real Nova | Google Fonts (OFL) |
| `LibreCaslonText-{Regular,Bold,Italic}.ttf` | Libre Caslon Text | Google Fonts (OFL) |
| `TimesNewRoman{,-Bold,-Italic,-BoldItalic}.ttf` | Times New Roman | copied from this Mac's system fonts |
| `Arial{,-Bold,-Italic,-BoldItalic}.ttf` | Arial | copied from this Mac's system fonts |
| `Georgia{,-Bold,-Italic,-BoldItalic}.ttf` | Georgia | copied from this Mac's system fonts |
| `Garamond.ttf` | Garamond | copied from your user fonts (Garamond Roman) |

## Not bundled (fallbacks apply)

| Expected file | Falls back to | Why missing |
|---|---|---|
| `Symbol.ttf` | pdf-lib built-in standard **Symbol** (same font) | not on this system as .ttf |
| `Calibri.ttf` (+`-Bold`,`-Italic`,`-BoldItalic`) | standard **Helvetica** | Microsoft font, ships with Office only |
| `Garamond-Bold.ttf` / `-Italic.ttf` | the regular `Garamond.ttf` file | only the Roman weight was on this system |

Drop any of these files in with the exact names above and they're picked up on
the next page load — no config needed. The in-app "Detected fonts" banner
always shows which file (or fallback) each detected font will export with.
