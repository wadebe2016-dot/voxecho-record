import { SetMetadata } from '@nestjs/common';

/**
 * Réserve une route à l'administrateur de **l'instance** — CLAUDE.md §9.22.
 *
 * À distinguer de `@Roles('ADMIN')`, qui désigne l'administrateur d'un
 * locataire : régler la conservation de sa banque et régler l'instance qui
 * héberge toutes les banques ne sont pas la même responsabilité, et le §9.9
 * avait laissé cette confusion en réserve.
 */
export const ADMIN_INSTANCE_KEY = 'adminInstance';
export const AdminInstance = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_INSTANCE_KEY, true);
