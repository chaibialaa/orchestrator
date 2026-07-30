<p align="center">
  <img src="docs/banniere.png" alt="Orchestrator" width="720">
</p>

<h1 align="center">Orchestrator</h1>

<p align="center"><b>Un juge décide, un agent exécute, une preuve tranche.</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-informational" alt="Node 20 ou plus">
  <img src="https://img.shields.io/badge/licence-PolyForm%20Noncommercial%201.0.0-blue" alt="Licence PolyForm Noncommercial 1.0.0">
  <img src="https://img.shields.io/badge/base-SQLite%20locale-lightgrey" alt="SQLite locale">
</p>

Une boucle de pilotage d'agents de code. L'outil supprime le copier-coller entre
la conversation qui pilote — celle où vous réfléchissez avec un modèle — et les
harnais qui travaillent vraiment dans le dépôt. Il lit la consigne, l'exécute,
dérive le coût et les livrables des traces, joint les rendus, reposte le compte
rendu. Le juge valide ou refuse, et la boucle enchaîne.

Et il **refuse de conclure un objectif tant que sa preuve n'est pas là.**

## L'idée

« Terminé » n'est pas un champ qu'un agent écrit, c'est une **condition qu'on
évalue**. Un objectif ne conclut que si :

- son critère de preuve est écrit — sans lui, personne ne peut le prendre ;
- ses sous-objectifs sont clos — un chapitre ne conclut pas avant ses parties ;
- une preuve `pass` existe, et **une image si le critère demande de voir** ;
- un rayon de souffle élevé a reçu une preuve du réel, pas un build vert ;
- le juge du projet s'est prononcé — et un refus **retire** son accord précédent ;
- aucun arrêt exigeant un humain ne reste ouvert.

Tout le reste est **dérivé, jamais déclaré** : le coût vient des transcripts, les
livrables des fichiers réellement écrits pendant la session, l'état d'activité
d'une tentative encore ouverte. Un agent ne peut pas oublier de déclarer ce qu'on
lit à sa place — et ne peut pas se décerner un succès.

## Démarrer

Le paquet n'est pas encore publié sur npm ; on l'installe depuis les sources.

```bash
git clone https://github.com/chaibialaa/orchestrator.git
cd orchestrator
npm install            # le serveur
npm --prefix web i     # l'interface
npm run build          # compile l'interface dans public/
npm start              # http://localhost:4747
```

Un seul processus sert l'interface **et** l'API. Les données vivent dans un
fichier SQLite sous `~/.orchestrator/` — pas de base à installer, une sauvegarde
se fait en copiant le fichier ; `orchestrator where` dit lequel.

## Déclarer un projet

À la racine de **chaque dépôt piloté**, un `.orchestrator.json` déclare ce qui
est local à cette machine. Le serveur, lui, ne stocke jamais une commande à
exécuter : c'est cette séparation qui permettra de l'héberger sans qu'il puisse
faire tourner quoi que ce soit chez quelqu'un.

```json
{
  "project": "mon-projet",
  "blastRadius": ["src/paiements/**", "migrations/*"],
  "proofs": {
    "build": "npm run build",
    "test": "npm test -- --run"
  },
  "probes": {
    "migrations_touchees": "git status --porcelain -- migrations | grep -c . || true"
  },
  "binaries": { "codex": "/chemin/vers/codex" },
  "env": { "NODE_ENV": "test" },
  "secrets": { "RUNPOD_API_KEY": "" }
}
```

| clé | ce qu'elle décide |
| --- | --- |
| `project` | le projet, côté serveur, auquel ce dépôt est rattaché |
| `blastRadius` | les chemins sensibles : y toucher exige une preuve du réel |
| `proofs` | les **seules** commandes exécutables — rien d'autre ne l'est jamais |
| `probes` | des relevés de diagnostic, joints au compte rendu |
| `binaries` | où trouver un harnais ; `ORCHESTRATOR_CODEX_BIN` l'emporte, sinon le PATH tranche |
| `env`, `secrets` | ce qu'on injecte dans l'environnement de l'agent (un secret vide n'écrase rien) |
| `deliverableDirs`, `deliverableIgnore` | borner le balayage des livrables, si le défaut ne suffit pas |

Ce fichier contient des chemins de machine et des clés : il est **ignoré par
git**, gardez-le local.

## La boucle

```bash
cd mon-projet
orchestrator chapter --objective 42 --budget 60 --max-turns 8 --post
```

`--post` commande **l'exécution et l'écriture** : sans lui, la boucle lit et
n'exécute rien. Et le garde-fou qui compte n'est pas le budget mais
`--budget-sans-progres` (40 $ par défaut) : ce qu'on tolère de dépenser sans
qu'un seul objectif soit prouvé. Ni les dollars ni le nombre de tours ne mesurent
l'avancement ; celui-là le fait.

Une boucle lancée en tâche de fond d'un terminal meurt avec lui. Détachez-la :

```bash
nohup orchestrator chapter --objective 42 --budget 60 --post \
  > chapitre-42.log 2>&1 < /dev/null & disown
```

## Commandes

```
orchestrator serve            l'interface et l'API
orchestrator chapter          la boucle : juger, exécuter, prouver, rendre compte
orchestrator plan --watch     découper un brief libre en étapes prouvables
orchestrator do <harnais>     une consigne unique, hors boucle (--probe : hors objectif)
orchestrator agents:check     constater ce qui est joignable sur cette machine
orchestrator inventory        ce que le dépôt contient vraiment
orchestrator prove <id> <clé> exécuter une preuve déclarée et la verser au dossier
orchestrator import <json>    reprendre un export
orchestrator where            où vit la base
```

`orchestrator` sans argument liste tout le reste.

## Développer

```bash
npm run dev          # interface en rechargement à chaud
npm run build        # compile l'interface dans public/
npm test             # les règles du gate, verrouillées
```

Les tests portent sur ce qui ne doit jamais céder : les conditions de conclusion
d'un objectif et la lecture des verdicts. Une règle qu'on assouplit sans le
vouloir est une promesse qu'on casse.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md) — usage libre pour tout **but non
commercial** : étude, projets personnels, recherche publique, écoles,
associations, administrations. Tout usage commercial demande une licence
séparée ; écrivez-moi.

Ce n'est **pas** une licence open source au sens de l'OSI, qui interdit de
restreindre les domaines d'usage — c'est du code source ouvert et lisible, sous
condition non commerciale.

© 2026 Chaibi Alaa
