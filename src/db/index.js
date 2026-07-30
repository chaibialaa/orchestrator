import Database from 'better-sqlite3'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ici = dirname(fileURLToPath(import.meta.url))

/**
 * Un fichier, pas un serveur. La base vit dans ~/.orchestrator/ par défaut :
 * on la sauvegarde en la copiant, on la déplace en la déplaçant, et personne
 * n'a besoin d'installer quoi que ce soit pour lire ses propres données.
 */
export function cheminBase() {
  return process.env.ORCHESTRATOR_DB ?? join(homedir(), '.orchestrator', 'orchestrator.db')
}

let db = null

export function base() {
  if (db) return db

  const chemin = cheminBase()
  mkdirSync(dirname(chemin), { recursive: true })

  db = new Database(chemin)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Plusieurs processus écrivent en même temps — la boucle, le serveur, le
  // découpeur de briefs. Sans attente, l'un d'eux se prend un SQLITE_BUSY.
  db.pragma('busy_timeout = 5000')

  db.exec(readFileSync(join(ici, 'schema.sql'), 'utf8'))
  ajouterColonnesManquantes(db)

  return db
}

/** Les colonnes JSON sont stockées en texte : on les rend telles qu'attendues. */
export const json = {
  lire(v, defaut = null) {
    if (v === null || v === undefined || v === '') return defaut
    try {
      return JSON.parse(v)
    } catch {
      return defaut
    }
  },
  ecrire(v) {
    return v === null || v === undefined ? null : JSON.stringify(v)
  },
}

/** L'heure, au format que la base stocke, en UTC — jamais l'heure locale. */
export function maintenant() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Le schéma se crée d'un bloc, mais une base existante ne se recrée pas. Les
 * colonnes ajoutées après coup se posent ici, une par une, sans jamais toucher
 * aux données : un utilisateur qui met à jour ne doit rien avoir à faire.
 */
function ajouterColonnesManquantes(db) {
  const ajouts = [
    // Ce que l'agent sait FAIRE, au-delà d'exécuter ou juger : générer des
    // images, de la 3D, un rendu. C'est ce qui permet à une mission de dire
    // « pour les images, utilise celui-ci » au lieu de laisser deviner.
    ['agents', 'capabilities', "TEXT"],
    // Le nom de la variable d'environnement qui porte son secret. La VALEUR
    // reste sur la machine : un serveur hébergé ne détiendra jamais la clé
    // RunPod de quelqu'un.
    ['agents', 'env_var', 'TEXT'],
    ['agents', 'endpoint', 'TEXT'],
    // Quelle conversation pilote ce projet, et laquelle des IA connectées la
    // tient. Figer une seule URL dans le code interdisait d'avoir un fil par
    // chantier — ou d'utiliser un autre juge que ChatGPT.
    ['projects', 'judge_agent', 'TEXT'],
    ['projects', 'judge_url', 'TEXT'],
    // La continuité est un choix PAR OBJECTIF : elle a du sens sur une boucle
    // d'itérations, aucun sur une étape indépendante. Jamais globale.
    ['objectives', 'resume_mode', "TEXT NOT NULL DEFAULT 'new'"],
    ['objectives', 'resume_session', 'TEXT'],
    // L'identifiant de la session du harnais, et celui dont elle hérite. Sans
    // ça, une reprise transporte de l'état que personne ne peut voir : on ne
    // saurait plus si l'ordre était mauvais ou l'exécution.
    ['passages', 'session_id', 'TEXT'],
    ['passages', 'resumed_from', 'TEXT'],
    // L'empreinte des mémoires au moment du relevé, et la dernière observée.
    // Sans ça, un relevé vieux de trois jours s'affiche comme la vérité du
    // moment alors que les fichiers ont changé dix fois depuis.
    ['scans', 'fingerprint', 'TEXT'],
    ['scans', 'fingerprint_seen', 'TEXT'],
    ['scans', 'seen_at', 'TEXT'],
    // Le nombre de preuves existantes au moment de l'arrêt. Comparer des
    // horodatages à la seconde ne distingue pas deux écritures rapprochées ;
    // un repère sur les identifiants, lui, ne ment pas.
    ['halts', 'evidence_mark', 'INTEGER'],
  ]

  for (const [table, colonne, type] of ajouts) {
    const existe = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === colonne)
    if (!existe) db.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne} ${type}`)
  }
}
