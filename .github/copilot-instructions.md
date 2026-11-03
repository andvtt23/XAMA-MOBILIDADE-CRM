# Copilot instructions for Xama CRM

## Project snapshot

This repository is a Vite + React single-page application for the Xama Mobilidade Urbana CRM. It tracks drivers and rides, weekly operational summaries, a base wallet, and financial reports parsed from WhatsApp conversation exports.

- App entry: `src/main.jsx`
- Main UI and business logic: `src/App.jsx`
- WhatsApp export parsing and commission threshold rule: `src/whatsappImport.js`
- Global design tokens and base theme: `src/index.css`
- All feature styling and dashboard layout: `src/App.css`
- Build tool: Vite (`vite.config.js`)

## Build, test, and lint commands

Use the package scripts defined in `package.json`:

- Install dependencies: `npm install`
- Start the app in development mode: `npm run dev`
- Production build: `npm run build`
- Lint: `npm run lint`
- Run import tests: `npm test`
- Run one import test: `node --test --test-name-pattern="direct TXT" src/whatsappImport.test.js`

The test script uses Node's built-in test runner and covers local WhatsApp TXT/ZIP extraction and validation.

## High-level architecture

The application is intentionally a self-contained browser app rather than a multi-layer backend project.

- `src/App.jsx` owns the UI state for drivers, manual rides, weekly calculations, payments, wallet movements, and imported financial reports.
- `src/whatsappImport.js` locally extracts `.txt` conversations from `.txt` or `.zip` WhatsApp exports using `fflate`, parses Android/iPhone message headers, identifies conservative ride candidates, extracts unambiguous BRL amounts, fingerprints files/rides, and applies the import commission rule.
- Date and currency helpers are centralized in the same file to keep the weekly logic consistent.
- Data is persisted in the browser via `localStorage` instead of a database; app-specific keys include `xama.crm.motoristas`, `xama.crm.corridas`, `xama.crm.pagamentos`, `xama.crm.transacoes`, `xama.crm.importacoes`, `xama.crm.corridasImportadas`, and `xama.crm.revisoesImportacao`.
- The UI is a single dashboard with operational and wallet tabs; summary cards, tables, and SVG chart logic are all rendered from the same component tree.
- `src/App.css` contains the green visual system for cards, tables, buttons, and panel layout. Preserve the existing palette and spacing when making UI edits.

## Key conventions in this codebase

- Keep the UI in Portuguese. Labels, headings, and user-facing copy are written in Brazilian Portuguese.
- Respect the existing green palette defined in `src/index.css` (`--xama-green`, `--xama-dark`, `--xama-light`, etc.) and reuse the established component patterns instead of introducing a new visual style.
- Weekly logic is anchored to Monday-Sunday windows using `inicioDaSemana()` and `deslocarDias()`. When changing period logic, keep the same date semantics.
- Imported-ride commissions are based on unique approved rides per driver/week: women receive 13% only above 80 rides, other drivers receive 10%, and Lyzandra always receives 10%. Driver classification must be explicit; do not infer gender from names.
- Do not auto-approve a WhatsApp candidate whose driver or fare is ambiguous. Keep it in the review queue; unapproved items must not affect financial totals.
- WhatsApp ZIP contents must be processed entirely in the browser; do not upload conversation files or their contents to external services.
- Duplicate WhatsApp exports and ride fingerprints must be checked before adding imported records. Without an explicit ride ID, keep duplicate/similarity handling conservative and surface uncertain collisions for review.
- Business values are stored and displayed in BRL using `pt-BR` locale formatting; do not switch to USD or another format unless the product explicitly requires it.
- Local persistence is expected to survive browser refreshes and closes, so any new state should be stored alongside the existing `localStorage` keys rather than introduced via a server or API layer.
- When adding a new feature, prefer a small extension of the existing `App` logic and CSS patterns over creating a separate app shell or framework.
- Temporary entity IDs in the app generally use `Date.now()`; WhatsApp imports also include file/ride fingerprints to detect repeat imports.
- CSV export and print actions are part of the product behavior, so avoid breaking those flows while changing the dashboard.

## Working style for future sessions

- Prefer surgical edits inside the existing React component and styling files rather than replacing the app structure.
- If a change affects calculations, verify both the weekly summary and the historical totals still agree with the same source data.
- Keep frontend-only persistence in mind; avoid introducing backend requirements or dependencies that are not already present in the repository.
