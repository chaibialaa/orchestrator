/**
 * Tout le vocabulaire visible par un humain. Le modèle de données garde
 * ses termes techniques ; l'écran, lui, parle français.
 */

export const statusLabel: Record<string, string> = {
  draft: 'À préciser',
  ready: 'Prêt à démarrer',
  in_progress: 'En cours',
  blocked: 'En attente de toi',
  proven: 'Terminé et vérifié',
  abandoned: 'Abandonné',
}

export const statusHelp: Record<string, string> = {
  draft: "On ne sait pas encore comment on saura que c'est fait. Personne ne peut le prendre.",
  ready: 'Le but et la vérification sont clairs. Un agent peut le prendre.',
  in_progress: "Un agent l'a pris en charge. La pastille dit si l'un d'eux y travaille en ce moment.",
  blocked: "L'outil s'est arrêté volontairement et attend une décision de ta part.",
  proven: "C'est fait, et la preuve a été fournie et acceptée.",
  abandoned: 'Écarté, on n’y revient pas.',
}

export const blastLabel: Record<string, string> = {
  cosmetic: 'Sans risque',
  feature: 'Risque limité',
  api: 'Touche aux données',
  critical: 'Critique',
}

export const blastHelp: Record<string, string> = {
  cosmetic: "Visuel ou confort. Si c'est raté, on le voit et on refait — l'agent avance seul.",
  feature: "Une fonction visible. Une vérification dans le vrai écran suffit — l'agent avance seul.",
  api: 'Données ou interface partagée. Une relecture humaine est demandée avant de conclure.',
  critical:
    'Argent, paie, mise en production. Aucune autonomie : une preuve dans le réel et ton accord sont exigés.',
}

export const harnessLabel: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gpt: 'GPT',
  human: 'Toi',
}

export const verdictLabel: Record<string, string> = {
  advanced: 'A fait avancer',
  no_progress: "N'a rien démontré",
  halted: "S'est arrêté",
  failed: 'A échoué',
}

export const evidenceLabel: Record<string, string> = {
  test: 'Test automatisé',
  e2e: 'Parcours réel dans l’écran',
  screenshot: 'Capture d’écran',
  render: 'Rendu visuel',
  diff: 'Vérification du code modifié',
  invariant: 'Mesure sur la production',
  manual: 'Vérifié à la main',
}

export const evidenceVerdictLabel: Record<string, string> = {
  pass: 'concluante',
  fail: 'en échec',
  inconclusive: 'non concluante',
}

export const haltLabel: Record<string, string> = {
  no_provable_criterion: 'On ne sait pas comment le vérifier',
  blast_radius: 'Trop risqué pour décider seul',
  piege_rule: 'Une règle du projet a été enfreinte',
  invariant_regression: 'Une mesure de production s’est dégradée',
  no_new_proof: 'Plusieurs essais, rien de démontré',
  budget: 'Budget atteint',
  human_request: 'Tu as demandé l’arrêt',
  verdict_rejected: 'Refusé au verdict, à reprendre',
  children_open: 'Des sous-objectifs sont encore ouverts',
  error: 'Erreur technique',
}

export const haltHelp: Record<string, string> = {
  no_provable_criterion:
    "Personne n'a su dire ce qui prouverait que c'est terminé. C'est le signe que la demande est encore trop floue — précise-la et l'outil repart.",
  blast_radius:
    "Le changement touche une zone sensible du projet. L'outil a préparé le travail mais refuse de conclure sans toi.",
  piege_rule:
    "Le code produit enfreint une règle qu'on s'est fixée après un incident passé. L'outil préfère s'arrêter plutôt que de la contourner.",
  invariant_regression:
    'Une mesure prise sur le site en production est sortie de sa limite. Le travail est suspendu, quelque chose vient de casser pour de vrai.',
  no_new_proof:
    "Plusieurs tentatives se sont enchaînées sans jamais rien démontrer. Continuer coûterait sans rien apporter : c'est souvent le signe qu'il faut changer d'approche, pas insister.",
  budget: "La limite de dépense fixée pour cet objectif est atteinte. À toi de dire si on continue.",
  human_request: 'Arrêt demandé explicitement.',
  verdict_rejected:
    "Le juge du projet a examiné le travail et l'a refusé. Ce n'est pas un blocage : c'est une consigne de reprise, avec la raison du refus.",
  children_open:
    "Un chapitre ne se conclut pas avant ses parties. Les sous-objectifs encore ouverts doivent être traités d'abord.",
  error: "Quelque chose a planté côté outil. À regarder avant de relancer.",
}

export function formatTokens(n: number | null | undefined): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} k`
  return `${(n / 1_000_000).toFixed(2)} M`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} ko`
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`
}
