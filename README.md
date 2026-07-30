# Orchestrator

Une boucle de pilotage d'agents : **un juge décide, un agent exécute, une preuve
tranche.** L'outil supprime le copier-coller entre la conversation qui pilote et
les harnais qui travaillent, et refuse de conclure un objectif tant que sa preuve
n'est pas là.

## Installer

```bash
npx orchestrator serve          # http://localhost:4747
```

Un seul processus : il sert l'interface **et** l'API. Les données vivent dans un
fichier SQLite sous `~/.orchestrator/` — pas de base à installer, une sauvegarde
se fait en copiant le fichier.

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
lit à sa place.

## Commandes

```
orchestrator serve            l'interface et l'API
orchestrator import <json>    reprendre un export
orchestrator chapter          la boucle : juger, exécuter, prouver, rendre compte
orchestrator plan --watch     découper un brief libre en étapes prouvables
orchestrator agents:check     constater ce qui est joignable sur cette machine
orchestrator where            où vit la base
```

Par projet, un `.orchestrator.json` déclare ce qui est **local** : le rayon de
souffle, les commandes de preuve, les sondes, les binaires — `"binaries": {
"codex": "/chemin/vers/codex" }`, ou la variable `ORCHESTRATOR_CODEX_BIN` qui
l'emporte ; sans rien, le PATH tranche. Le serveur ne stocke
jamais de commande à exécuter — c'est ce qui permettra de l'héberger sans qu'il
puisse faire tourner quoi que ce soit chez quelqu'un.

## Développer

```bash
npm install          # le serveur
npm --prefix web i   # l'interface
npm run dev          # interface en rechargement à chaud
npm run build        # compile l'interface dans public/
npm test             # les règles du gate, verrouillées
```

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md) — usage libre pour tout **but non
commercial** : étude, projets personnels, recherche publique, écoles,
associations, administrations. Tout usage commercial demande une licence
séparée ; écrivez-moi.

Ce n'est **pas** une licence open source au sens de l'OSI, qui interdit de
restreindre les domaines d'usage — c'est du code source ouvert et lisible, sous
condition non commerciale.
