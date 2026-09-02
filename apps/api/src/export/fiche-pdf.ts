import PDFDocument from 'pdfkit';
import type { ExportManifest } from '@voxecho/shared';

/**
 * Fiche d'export au format PDF — CLAUDE.md §6.
 *
 * C'est la page qu'un contrôleur imprime et agrafe à son dossier. Elle doit
 * tenir sur une feuille, se lire sans le portail, et porter l'empreinte en
 * entier : c'est la valeur qu'il recopiera pour la confronter à la sienne.
 *
 * Aucune police n'est embarquée : Helvetica est l'une des quatorze polices
 * garanties par le format PDF, et son encodage WinAnsi couvre les accents du
 * français. Un export ne doit dépendre d'aucun fichier présent sur la machine
 * qui l'a produit.
 */

const MARGE = 56;
const ARDOISE = '#1e293b';
const GRIS = '#64748b';
const ALERTE = '#991b1b';

export async function construireFichePdf(manifest: ExportManifest): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGE,
    info: {
      Title: `Fiche d'export — appel ${manifest.appel.refci}`,
      Author: manifest.produit,
      Subject: `Export du ${manifest.emisLe} par ${manifest.demandeur.email}`,
      Creator: manifest.produit,
    },
  });

  const morceaux: Buffer[] = [];
  doc.on('data', (morceau: Buffer) => morceaux.push(morceau));
  const termine = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);
  });

  entete(doc, manifest);

  if (manifest.preuve.integrite === 'divergente') {
    // Une pièce dont l'empreinte a bougé peut encore devoir sortir — pour
    // enquêter sur ce qui lui est arrivé — mais elle ne doit jamais circuler
    // en se faisant passer pour une preuve intacte.
    bandeauAlerte(doc);
  }

  section(doc, 'Appel', [
    ['Référence PBX', manifest.appel.refci],
    ['Sens', manifest.appel.sens],
    ['Poste enregistré', manifest.appel.poste],
    ['Correspondant', manifest.appel.correspondant],
    ['Début', manifest.appel.debuteLe],
    ['Durée', `${manifest.appel.dureeSec} s`],
    ['Source de capture', manifest.appel.source],
    ['Statut', manifest.appel.statut],
    ['Catégorie d’opération', manifest.appel.categorieOperation],
    ['Conservation forcée', manifest.appel.sousConservationForcee ? 'oui, mesure active' : 'non'],
  ]);

  section(doc, 'Demandeur', [
    ['Compte', manifest.demandeur.email],
    ['Rôle', manifest.demandeur.role],
    ['Locataire', manifest.locataire.nom],
    ['Export émis le', manifest.emisLe],
    ['Identifiant d’export', manifest.exportId],
  ]);

  section(doc, 'Preuve d’intégrité', [
    ['Fichier audio', manifest.preuve.fichierAudio],
    ['Taille', `${manifest.preuve.octets} octets`],
    [
      'Vérification',
      manifest.preuve.integrite === 'concordante'
        ? 'empreinte concordante avec celle relevée à l’ingestion'
        : 'EMPREINTE DIVERGENTE — voir l’avertissement ci-dessus',
    ],
  ]);

  empreinte(doc, 'SHA-256 relevé à l’ingestion', manifest.preuve.sha256Ingestion);
  empreinte(doc, 'SHA-256 recalculé à l’export', manifest.preuve.sha256Export);

  pied(doc, manifest.mention);

  doc.end();
  return termine;
}

function entete(doc: PDFKit.PDFDocument, manifest: ExportManifest): void {
  doc.fillColor(ARDOISE).font('Helvetica-Bold').fontSize(16).text(manifest.produit);
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(GRIS)
    .text(`Fiche d’export — appel ${manifest.appel.refci}`);
  doc.moveDown(0.8);
  const y = doc.y;
  doc
    .moveTo(MARGE, y)
    .lineTo(doc.page.width - MARGE, y)
    .strokeColor('#cbd5e1')
    .stroke();
  doc.moveDown(0.8);
}

function bandeauAlerte(doc: PDFKit.PDFDocument): void {
  const largeur = doc.page.width - MARGE * 2;
  const haut = doc.y;
  doc.rect(MARGE, haut, largeur, 52).fillColor('#fee2e2').fill();
  doc
    .fillColor(ALERTE)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text('AVERTISSEMENT — intégrité non vérifiée', MARGE + 10, haut + 10, {
      width: largeur - 20,
    });
  doc
    .font('Helvetica')
    .fontSize(9)
    .text(
      'Le fichier exporté ne porte plus l’empreinte relevée lors de son ingestion. Il ne peut pas être présenté comme une pièce intacte. Cet écart est consigné au journal d’audit.',
      MARGE + 10,
      haut + 26,
      { width: largeur - 20 },
    );
  doc.y = haut + 62;
  doc.x = MARGE;
}

function section(doc: PDFKit.PDFDocument, titre: string, lignes: [string, string][]): void {
  doc.moveDown(0.4);
  doc.fillColor(ARDOISE).font('Helvetica-Bold').fontSize(11).text(titre);
  doc.moveDown(0.3);

  for (const [intitule, valeur] of lignes) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(GRIS).text(intitule, MARGE, y, { width: 150 });
    doc
      .fontSize(10)
      .fillColor(ARDOISE)
      .text(valeur, MARGE + 160, y, { width: doc.page.width - MARGE * 2 - 160 });
    doc.moveDown(0.2);
  }
  doc.x = MARGE;
}

/**
 * L'empreinte occupe sa propre ligne, en chasse fixe et en entier. Une
 * empreinte tronquée ne sert à rien : elle n'est là que pour être comparée.
 */
function empreinte(doc: PDFKit.PDFDocument, intitule: string, valeur: string): void {
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(9).fillColor(GRIS).text(intitule, MARGE, doc.y);
  doc.moveDown(0.2);
  doc
    .font('Courier')
    .fontSize(10)
    .fillColor(ARDOISE)
    .text(valeur, MARGE, doc.y, { width: doc.page.width - MARGE * 2 });
  doc.x = MARGE;
}

function pied(doc: PDFKit.PDFDocument, mention: string): void {
  doc.moveDown(1.2);
  const y = doc.y;
  doc
    .moveTo(MARGE, y)
    .lineTo(doc.page.width - MARGE, y)
    .strokeColor('#cbd5e1')
    .stroke();
  doc.moveDown(0.6);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(GRIS)
    .text(mention, MARGE, doc.y, {
      width: doc.page.width - MARGE * 2,
    });
}
