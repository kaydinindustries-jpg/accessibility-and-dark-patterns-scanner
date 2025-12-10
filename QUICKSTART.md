# Quick Start Guide

## ✅ Implémentation Complète

Tout le plan du `prompt1.txt` a été implémenté avec succès :

### 1. ✅ Extension (Dark Patterns UI)
- **Fichiers créés/modifiés** :
  - `sidepanel.html` : Onglets Accessibility + Dark Patterns
  - `sidepanel.css` : Styles pour les deux onglets + cartes dark patterns
  - `sidepanel.js` : Gestion des deux onglets, scan dark patterns, highlight, filtres
  - `darkPatternsContent.js` : Déjà présent, heuristiques DOM V1
  - `service_worker.js` : Déjà présent, orchestration scans + mock backend
  - `config.js` : Déjà présent, configuration runtime
  - `storage.js` : Déjà présent, IndexedDB pour historique

### 2. ✅ Backend API (`/api/analyze-ui`)
- **Fichiers créés** :
  - `scanner/src/schema.ts` : Schémas Zod (AnalyzeUIRequest, AnalyzeUIResponse)
  - `scanner/src/services/openaiClient.ts` : Client OpenAI avec prompts
  - `scanner/src/routes/analyze-ui.ts` : Route POST /api/analyze-ui
  - `scanner/src/index.ts` : Modifié pour brancher la route
  - `scanner/package.json` : Ajout dépendances `openai` + `zod`

### 3. ✅ Test Pages
- **Fichiers créés** :
  - `test-pages/cookie_nudge_bad.html`
  - `test-pages/cookie_nudge_good.html`
  - `test-pages/preselected_addon_bad.html`
  - `test-pages/roach_motel_bad.html`
  - `test-pages/hidden_information_bad.html`
  - `test-pages/misleading_label_bad.html`
  - `test-pages/README.md`

### 4. ✅ Documentation
- **Fichiers créés** :
  - `docs/dark_patterns_v1.md` : Taxonomie complète des patterns, heuristiques, exemples
  - `docs/usage_saas_preview.md` : Guide d'utilisation pour clients B2B
  - `README.md` : Mis à jour avec double fonctionnalité

---

## Installation & Test

### 1. Extension Chrome

```bash
# Le repo est déjà prêt !
# Ouvrir chrome://extensions/
# Activer "Mode développeur"
# Cliquer "Charger l'extension non empaquetée"
# Sélectionner le dossier racine du repo
```

### 2. Backend (pour vraie analyse OpenAI)

```bash
cd scanner

# Dépendances déjà installées !
# npm install (déjà fait)

# Compiler TypeScript
npm run build

# Configurer
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini
export PORT=3000
export LOG_VERBOSE=1  # Pour debug

# Lancer
npm start
```

### 3. Configuration Extension

Dans la console Chrome DevTools de l'extension :

```javascript
// Pointer vers votre backend
chrome.storage.sync.set({ backendUrl: "http://localhost:3000" })

// OU utiliser le mode mock (sans backend)
chrome.storage.sync.set({ useMockBackend: true })
```

### 4. Test avec pages de démo

```bash
# Ouvrir une page de test dans Chrome
open test-pages/cookie_nudge_bad.html

# Puis dans l'extension :
# 1. Ouvrir le Side Panel
# 2. Onglet "Dark Patterns"
# 3. Cliquer "Scan dark patterns"
# 4. Observer les résultats !
```

---

## Architecture Finale

```
Extension Chrome (MV3)
├── manifest.json
├── service_worker.js          (orchestration, messages, mock backend)
├── darkPatternsContent.js     (heuristiques DOM, collecte candidates)
├── config.js                  (backendUrl, flags, timeouts)
├── storage.js                 (IndexedDB: scans + dark_scans)
├── popup.html/js              (bouton scan, WCAG-EM sampling)
├── sidepanel.html/js/css      (onglets Accessibility + Dark Patterns)
├── exporter.js                (exports DOC/CSV/JSON)
└── libs/axe.min.js            (axe-core)

Backend API (Node/TS + Express)
└── scanner/
    ├── src/
    │   ├── index.ts                      (serveur principal)
    │   ├── schema.ts                     (Zod schemas)
    │   ├── routes/analyze-ui.ts          (POST /api/analyze-ui)
    │   ├── services/openaiClient.ts      (OpenAI + prompts)
    │   └── history.ts                    (metrics, diffs)
    └── package.json                      (openai, zod, express, pg, etc.)

Tests & Docs
├── test-pages/                (HTML démo pour chaque pattern)
└── docs/
    ├── dark_patterns_v1.md    (taxonomie complète)
    └── usage_saas_preview.md  (guide utilisation B2B)
```

---

## Fonctionnalités Implémentées

### Accessibility Scanner (existant, préservé)
✅ Scan axe-core local  
✅ Mesure contraste custom (normal/hover/focus)  
✅ Scores WCAG par principe  
✅ WCAG-EM sampling  
✅ Exports JSON/CSV/DOC  
✅ Historique IndexedDB  

### Dark Pattern Watchdog (nouveau)
✅ 6 pattern types détectés  
✅ Heuristiques DOM locales  
✅ Analyse backend OpenAI  
✅ Mode mock pour dev  
✅ UI Side Panel dédiée  
✅ Highlight in-page  
✅ Filtres par type + risk  
✅ Export findings (prêt pour JSON/CSV/DOC)  
✅ Timeout 10s configurable  
✅ Logs sécurisés (hash URL)  

---

## Prochaines Étapes

### Test Complet

1. **Test accessibilité** (déjà fonctionnel) :
   - Ouvrir n'importe quelle page
   - Scanner → voir scores + violations

2. **Test dark patterns mode mock** :
   ```javascript
   chrome.storage.sync.set({ useMockBackend: true })
   ```
   - Ouvrir `test-pages/cookie_nudge_bad.html`
   - Side Panel → Dark Patterns → Scan
   - Résultat : patterns détectés avec mock

3. **Test dark patterns avec OpenAI** :
   - Lancer backend (`cd scanner && npm start`)
   - Configurer extension :
     ```javascript
     chrome.storage.sync.set({ 
       backendUrl: "http://localhost:3000",
       useMockBackend: false 
     })
     ```
   - Scanner une vraie page → analyse GPT

### Validation

- ✅ Extension charge sans erreur
- ✅ Onglets accessibilité + dark patterns présents
- ✅ Heuristiques DOM fonctionnent
- ✅ Backend compile sans erreur TypeScript
- ✅ Schémas Zod validés
- ✅ Test pages créées
- ✅ Documentation complète

### Améliorations Futures (post-V1)

- [ ] Tests automatisés (Vitest + JSDOM)
- [ ] Multi-langue (FR, DE, ES)
- [ ] Export rapport combiné (accessibility + dark patterns)
- [ ] CI/CD integration
- [ ] A/B test detection
- [ ] Dynamic flow testing

---

## Résumé

**Statut** : ✅ **COMPLET** selon le plan de `prompt1.txt`

- **7/7 todos** terminés
- **Extension** : UI complète avec 2 onglets
- **Backend** : API `/api/analyze-ui` fonctionnelle
- **Tests** : Pages HTML de démo
- **Docs** : Taxonomie + guide utilisation

**Prêt pour** : Démo clients B2B, premiers scans, amélioration itérative

**Note** : Ceci est un outil de **pré-audit technique**, pas une certification légale.

