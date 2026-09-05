/**
 * Déclare des planchers réglementaires pour la suite qui importe ce module.
 *
 * **À importer avant `AppModule`** : la configuration est lue au chargement du
 * module, pas à l'instanciation de l'application (voir `chiffrement-actif`).
 */
process.env.RETENTION_REGULATORY_FLOORS = 'confirmation_cheque:3650,operation_change:1825';
