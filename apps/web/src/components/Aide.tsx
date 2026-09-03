/**
 * Aide contextuelle — une icône, une infobulle, rien de plus.
 *
 * Les écrans du portail expliquaient le produit à chaque champ. Un
 * professionnel n'en a pas besoin : cela alourdit la lecture et donne à
 * l'outil l'air de se justifier. Ce qui mérite d'être expliqué l'est ici, au
 * survol, et en entier dans `docs/manuel-utilisateur.md`.
 */
export function Aide({ texte }: { texte: string }) {
  return (
    <span
      role="img"
      aria-label={texte}
      title={texte}
      tabIndex={0}
      className="ml-1 cursor-help select-none align-middle text-xs text-ardoise-400 hover:text-ardoise-700"
    >
      ⓘ
    </span>
  );
}
