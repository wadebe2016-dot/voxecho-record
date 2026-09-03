import { IsObject } from 'class-validator';

/**
 * Écriture du brouillon. Le document est validé par le contrat partagé, et
 * non par des décorateurs : c'est le même validateur que celui du connecteur
 * et du portail, sans quoi trois lectures divergentes du même document
 * finiraient par exister.
 */
export class SavePolicyDraftDto {
  @IsObject()
  document!: unknown;
}
