# EAA/WCAG Auditor (Local MV3)

Extension Chrome MV3 100% locale. Scanner d’accessibilité avec axe-core, mapping WCAG 2.2 → EN 301 549 v3.2.1, exports DOC/JSON/CSV, stockage IndexedDB. Zéro réseau, zéro télémétrie.

## Installation locale
1. Télécharger les dépendances libres et les déposer en local dans `libs/`:
   - `axe.min.js` (axe-core, MPL 2.0)
2. Ouvrir chrome://extensions, activer Mode développeur, "Charger l’extension non empaquetée" et choisir ce dossier.

## Permissions minimales
- `activeTab`, `scripting`, `storage`, `downloads`, `offscreen`.

## Utilisation
- Ouvrir une page, cliquer sur l’icône, "Scan". Filtrer et exporter.

## Limites
- Iframes cross-origin/CSP peuvent empêcher l’analyse complète (indication "scan partiel").
- Résultats = pré-audit technique, pas certification.

## Tests rapides
- Scanner 10 pages de gabarits (home, article, formulaire, SPA, etc.).
- Injection OK, mapping OK, export OK, < 2 s pour ~1 Mo, 0 erreur console.

## Politique
- Aucune collecte de données, aucune télémétrie, tout local.