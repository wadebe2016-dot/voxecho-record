import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * La route audio est ouverte au sens du garde JWT — un `<audio>` ne peut pas
 * porter d'en-tête `Authorization` — mais elle exige un billet d'écoute, qui
 * a été délivré, lui, à un compte authentifié et dont la délivrance est au
 * journal.
 */
export class ListenAudioDto {
  @IsString()
  @IsNotEmpty({ message: 'Billet d’écoute requis.' })
  @MaxLength(4096)
  ticket!: string;
}
