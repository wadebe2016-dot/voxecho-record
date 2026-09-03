import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Publication d'une politique. La note dit ce que la version change et
 * pourquoi : renoncer d'avance à des preuves se motive, comme une dérogation
 * de conservation (§9.6) ou une purge (§9.7).
 */
export class PublishPolicyDto {
  @IsString()
  @MinLength(10, { message: 'note : au moins dix caractères, pas une initiale' })
  @MaxLength(500)
  note!: string;
}
