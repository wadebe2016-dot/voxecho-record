import PDFDocument from 'pdfkit';
import type { CertificatDestruction } from '@voxecho/shared';

/**
 * Certificat de destruction au format PDF — CLAUDE.md §9.31.
 *
 * La pièce qu'un responsable conformité range dans son dossier et présente au
 * contrôle. Elle doit se lire sans le portail, tenir la comparaison des mois
 * plus tard, et porter l'empreinte en entier — c'est elle qui prouve que le
 * document présenté est celui qui a été délivré.
 *
 * Aucune police embarquée, comme la fiche d'export du §9.8 : Helvetica et
 * Courier sont garanties par le format.
 */

const MARGE = 48;
const ARDOISE = '#1e293b';
const GRIS = '#64748b';

export async function construireCertificatPdf(
  certificat: CertificatDestruction,
  empreinte: string,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGE,
    info: {
      Title: `Certificat de destruction — rapport ${certificat.rapportId}`,
      Author: certificat.produit,
      Subject: `Destruction du ${certificat.executeLe} par ${certificat.executePar}`,
      Creator: certificat.produit,
    },
  });

  const morceaux: Buffer[] = [];
  doc.on('data', (morceau: Buffer) => morceaux.push(morceau));
  const termine = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);
  });

  doc.font('Helvetica-Bold').fontSize(16).fillColor(ARDOISE).text('Certificat de destruction');
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(GRIS)
    .text(`${certificat.produit} — ${certificat.locataire.nom}`)
    .moveDown(1);

  section(doc, 'Opération', [
    ['Rapport', certificat.rapportId],
    ['Demandé le', certificat.demandeLe],
    ['Demandé par', certificat.demandePar],
    ['Exécuté le', certificat.executeLe],
    ['Exécuté par', certificat.executePar],
    ['Motif', certificat.motif],
    ['Échéance appliquée', certificat.echeance],
    [
      'Conservation appliquée',
      Object.entries(certificat.politiqueAppliquee)
        .map(([perimetre, jours]) => `${perimetre === 'all' ? 'générale' : perimetre} : ${jours} j`)
        .join(' · '),
    ],
  ]);

  section(doc, 'Bilan', [
    ['Enregistrements détruits', String(certificat.totaux.detruits)],
    ['Volume libéré', `${certificat.totaux.octets} octets`],
    ['Épargnés par conservation forcée', String(certificat.totaux.epargnes)],
  ]);

  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(ARDOISE).text('Enregistrements détruits');
  doc.moveDown(0.3);

  if (certificat.detruits.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor(GRIS).text('Aucun.');
  }

  for (const ligne of certificat.detruits) {
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(ARDOISE)
      .text(
        `${ligne.refci} · ${ligne.debuteLe.slice(0, 19).replace('T', ' ')} · ${ligne.categorie} · ` +
          `conservation ${ligne.dureeAppliqueeJours} j · ${ligne.octets} octets` +
          (ligne.fichierDejaAbsent ? ' · fichier déjà absent' : ''),
      );
    doc.font('Courier').fontSize(7).fillColor(GRIS).text(`  ${ligne.sha256}`);
  }

  if (certificat.epargnes.length > 0) {
    doc.moveDown(0.7);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ARDOISE).text('Épargnés');
    doc.moveDown(0.3);
    for (const ligne of certificat.epargnes) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(ARDOISE)
        .text(`${ligne.refci} — ${ligne.motifConservation ?? 'conservation forcée'}`);
    }
  }

  doc.moveDown(1);
  doc.font('Helvetica').fontSize(8).fillColor(GRIS).text(certificat.mention, { align: 'justify' });
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(ARDOISE).text('Empreinte du certificat');
  doc.font('Courier').fontSize(8).fillColor(ARDOISE).text(empreinte);

  doc.end();
  return termine;
}

function section(doc: PDFKit.PDFDocument, titre: string, lignes: [string, string][]): void {
  doc.font('Helvetica-Bold').fontSize(10).fillColor(ARDOISE).text(titre);
  doc.moveDown(0.2);
  for (const [cle, valeur] of lignes) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GRIS)
      .text(`${cle} : `, { continued: true })
      .fillColor(ARDOISE)
      .text(valeur);
  }
  doc.moveDown(0.6);
}
