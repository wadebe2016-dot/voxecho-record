import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';

/**
 * Inventaire du stockage — CLAUDE.md §9.14.
 *
 * Le produit ne recopie pas les pièces audio : elles pèsent lourd, et leur
 * copie relève des moyens de l'exploitant (instantané de volume, rsync,
 * sauvegarde d'entreprise). Ce qu'il apporte, c'est le moyen de **prouver**
 * que la copie est complète et intacte : une ligne par pièce, avec ce que la
 * base retient d'elle. Une sauvegarde qu'on ne sait pas confronter au disque
 * n'est qu'une promesse.
 *
 * Une ligne par pièce, en JSON Lines : le fichier se lit en flux, se coupe,
 * se compare avec les outils de n'importe quel exploitant, et un stockage de
 * plusieurs centaines de milliers d'appels ne passe jamais par la mémoire.
 */

export const ligneInventaireSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Chemin relatif à `STORAGE_DIR`, tel qu'inscrit en base (§9.3). */
  chemin: z.string(),
  /** Empreinte du **clair**, relevée à l'ingestion — la valeur probante. */
  sha256: z.string(),
  /** Taille du clair. Une pièce scellée pèse davantage sur le disque. */
  octets: z.number().int().nonnegative(),
  statut: z.string(),
  scellee: z.boolean(),
  cle: z.string().nullable(),
});

export type LigneInventaire = z.infer<typeof ligneInventaireSchema>;

export function serialiserLigne(ligne: LigneInventaire): string {
  // Ordre des champs figé : une même base doit donner le même inventaire,
  // sans quoi l'empreinte du fichier ne prouverait rien.
  return `${JSON.stringify({
    id: ligne.id,
    tenantId: ligne.tenantId,
    chemin: ligne.chemin,
    sha256: ligne.sha256,
    octets: ligne.octets,
    statut: ligne.statut,
    scellee: ligne.scellee,
    cle: ligne.cle,
  })}\n`;
}

export function lireLigne(brut: string, numero: number): LigneInventaire {
  const resultat = ligneInventaireSchema.safeParse(JSON.parse(brut) as unknown);
  if (!resultat.success) {
    throw new Error(
      `Inventaire illisible à la ligne ${numero} : ${resultat.error.issues[0]?.message}`,
    );
  }
  return resultat.data;
}

/** Relit un inventaire ligne à ligne, sans jamais le charger en entier. */
export async function* parcourirInventaire(chemin: string): AsyncGenerator<LigneInventaire> {
  const lecteur = createInterface({
    input: createReadStream(chemin, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let numero = 0;
  for await (const ligne of lecteur) {
    numero += 1;
    if (ligne.trim() === '') continue;
    yield lireLigne(ligne, numero);
  }
}
