import type { CertificatDestruction } from '@voxecho/shared';

/**
 * Certificat de destruction au format CSV — CLAUDE.md §9.31.
 *
 * Le PDF se range dans un dossier ; le CSV se recoupe avec un inventaire. Les
 * mêmes données, dans la forme qu'attend un tableur français : point-virgule,
 * marque d'ordre d'octets, et formules neutralisées comme au §9.11.
 *
 * L'en-tête porte les métadonnées de l'opération en commentaires : un fichier
 * de colonnes seul ne dirait pas de quelle destruction il parle.
 */

const COLONNES = [
  'identifiant',
  'refci',
  'debute_le',
  'categorie',
  'conservation_jours',
  'octets',
  'sha256',
  'fichier_deja_absent',
];

export function construireCertificatCsv(
  certificat: CertificatDestruction,
  empreinte: string,
): string {
  const entetes = [
    `# Certificat de destruction — ${certificat.produit}`,
    `# Locataire;${certificat.locataire.nom}`,
    `# Rapport;${certificat.rapportId}`,
    `# Exécuté le;${certificat.executeLe}`,
    `# Exécuté par;${certificat.executePar}`,
    `# Motif;${certificat.motif}`,
    `# Conservation appliquée;${Object.entries(certificat.politiqueAppliquee)
      .map(([perimetre, jours]) => `${perimetre}=${jours}j`)
      .join(' ')}`,
    `# Détruits;${certificat.totaux.detruits}`,
    `# Épargnés par conservation forcée;${certificat.totaux.epargnes}`,
    `# Empreinte du certificat;${empreinte}`,
  ];

  const lignes = certificat.detruits.map((ligne) =>
    [
      ligne.recordingId,
      ligne.refci,
      ligne.debuteLe,
      ligne.categorie,
      String(ligne.dureeAppliqueeJours),
      String(ligne.octets),
      ligne.sha256,
      ligne.fichierDejaAbsent ? 'oui' : 'non',
    ]
      .map(echapper)
      .join(';'),
  );

  // \uFEFF écrit en échappement : le caractère lui-même, invisible dans le
  // code, se perd au premier copier-coller — et le lint le refuse, à raison.
  return `\uFEFF${[...entetes, COLONNES.join(';'), ...lignes].join('\r\n')}\r\n`;
}

/** Même échappement qu'au §9.11 : un champ libre ne doit pas s'exécuter. */
function echapper(valeur: string): string {
  const neutralise = /^[=+\-@]/.test(valeur) ? `'${valeur}` : valeur;
  return /[";\r\n]/.test(neutralise) ? `"${neutralise.replaceAll('"', '""')}"` : neutralise;
}
