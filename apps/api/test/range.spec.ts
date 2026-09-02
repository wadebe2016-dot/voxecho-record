import { analyserRange } from '../src/recordings/range';

/**
 * Analyse de l'en-tête `Range` — RFC 9110 §14. Les bornes sont **incluses**
 * des deux côtés : c'est la source d'erreur d'un octet la plus banale, et
 * celle qui fait qu'un lecteur audio coupe une demi-seconde avant la fin.
 */
describe('analyse de l’en-tête Range', () => {
  const TAILLE = 1_000;

  it('sans en-tête, sert le fichier entier', () => {
    expect(analyserRange(undefined, TAILLE)).toEqual({ type: 'complet' });
    expect(analyserRange('', TAILLE)).toEqual({ type: 'complet' });
  });

  it('lit une plage bornée des deux côtés, bornes incluses', () => {
    expect(analyserRange('bytes=0-499', TAILLE)).toEqual({
      type: 'partiel',
      plage: { debut: 0, fin: 499 },
    });
  });

  it('lit une plage ouverte : du point demandé jusqu’au dernier octet', () => {
    expect(analyserRange('bytes=500-', TAILLE)).toEqual({
      type: 'partiel',
      plage: { debut: 500, fin: 999 },
    });
  });

  it('lit un suffixe : les N derniers octets', () => {
    expect(analyserRange('bytes=-100', TAILLE)).toEqual({
      type: 'partiel',
      plage: { debut: 900, fin: 999 },
    });
  });

  it('rend le fichier entier quand le suffixe le dépasse', () => {
    expect(analyserRange('bytes=-5000', TAILLE)).toEqual({
      type: 'partiel',
      plage: { debut: 0, fin: 999 },
    });
  });

  it('ramène une fin au-delà du fichier au dernier octet plutôt que de refuser', () => {
    // C'est ce qu'attendent les lecteurs : ils demandent large et se
    // contentent de ce qui existe.
    expect(analyserRange('bytes=900-99999', TAILLE)).toEqual({
      type: 'partiel',
      plage: { debut: 900, fin: 999 },
    });
  });

  it('accepte le tout dernier octet', () => {
    expect(analyserRange('bytes=999-999', TAILLE)).toEqual({
      type: 'partiel',
      plage: { debut: 999, fin: 999 },
    });
  });

  it('refuse un début au-delà du fichier', () => {
    expect(analyserRange('bytes=1000-', TAILLE)).toEqual({ type: 'insatisfiable' });
    expect(analyserRange('bytes=5000-6000', TAILLE)).toEqual({ type: 'insatisfiable' });
  });

  it('refuse une plage à l’envers', () => {
    expect(analyserRange('bytes=500-100', TAILLE)).toEqual({ type: 'insatisfiable' });
  });

  it('refuse un suffixe nul : « les zéro derniers octets » ne désigne rien', () => {
    expect(analyserRange('bytes=-0', TAILLE)).toEqual({ type: 'insatisfiable' });
  });

  it('refuse toute plage sur un fichier vide', () => {
    expect(analyserRange('bytes=0-0', 0)).toEqual({ type: 'insatisfiable' });
  });

  it('ignore une unité inconnue plutôt que d’échouer', () => {
    expect(analyserRange('items=0-10', TAILLE)).toEqual({ type: 'complet' });
    expect(analyserRange('bytes=abc', TAILLE)).toEqual({ type: 'complet' });
  });

  it('ignore une demande à plusieurs plages : on n’en sert qu’une, ou tout', () => {
    // La RFC autorise à ignorer l'en-tête ; fabriquer un multipart que
    // personne ne réclame serait pire.
    expect(analyserRange('bytes=0-99,200-299', TAILLE)).toEqual({ type: 'complet' });
  });
});
