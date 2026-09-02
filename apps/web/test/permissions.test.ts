import { describe, expect, it } from 'vitest';
import { peut } from '../src/lib/permissions';

describe('masquage par rôle', () => {
  it('ouvre les enregistrements aux trois rôles', () => {
    expect(peut('ADMIN', 'consulterEnregistrements')).toBe(true);
    expect(peut('SUPERVISOR', 'consulterEnregistrements')).toBe(true);
    expect(peut('AUDITOR', 'consulterEnregistrements')).toBe(true);
  });

  it('réserve le journal d’audit à l’administrateur et à l’auditeur', () => {
    expect(peut('ADMIN', 'consulterJournalAudit')).toBe(true);
    expect(peut('AUDITOR', 'consulterJournalAudit')).toBe(true);
    expect(peut('SUPERVISOR', 'consulterJournalAudit')).toBe(false);
  });

  it('réserve l’administration à l’administrateur', () => {
    expect(peut('ADMIN', 'gererComptes')).toBe(true);
    expect(peut('AUDITOR', 'gererComptes')).toBe(false);
    expect(peut('SUPERVISOR', 'gererRetention')).toBe(false);
  });

  it('n’accorde rien sans rôle', () => {
    expect(peut(undefined, 'consulterEnregistrements')).toBe(false);
  });
});
