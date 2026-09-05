# Samba AD de laboratoire

Pour éprouver l'onglet Annuaire (§9.37) sans contrôleur de domaine réel. À
monter sur un poste de développement, **jamais** sur une instance publique :
les mots de passe ci-dessous sont écrits en clair.

```bash
docker compose -f deploy/lab/samba-ad.yml up -d
docker exec voxecho-lab-ad samba-tool domain level show   # attendre qu'il réponde
```

Deux groupes et deux utilisateurs, aux noms que la recette attend :

```bash
D=voxecho-lab-ad
docker exec $D samba-tool group add VoxEcho-Admins
docker exec $D samba-tool group add VoxEcho-Auditeurs
docker exec $D samba-tool user create nkolo 'Annuaire-2026!' \
  --given-name=Paul --surname=Nkolo --mail-address=nkolo@lab.voxecho.local
docker exec $D samba-tool user create mbarga 'Annuaire-2026!' \
  --given-name=Alice --surname=Mbarga --mail-address=mbarga@lab.voxecho.local
docker exec $D samba-tool group addmembers VoxEcho-Admins nkolo
docker exec $D samba-tool group addmembers VoxEcho-Auditeurs mbarga
```

Un compte de service pour la liaison — le produit ne se lie jamais avec un
compte d'administration :

```bash
docker exec $D samba-tool user create svc-voxecho 'Liaison-2026!' \
  --description='Compte de liaison VoxEcho Record'
```

## Ce qu'on saisit dans l'onglet Annuaire

| Champ | Valeur |
| --- | --- |
| URL | `ldaps://127.0.0.1:3636` |
| Valider le certificat | **non** — le certificat est auto-signé (labo seulement) |
| Base DN | `DC=lab,DC=voxecho,DC=local` |
| DN de liaison | `CN=svc-voxecho,CN=Users,DC=lab,DC=voxecho,DC=local` |
| Mot de passe | `Liaison-2026!` |
| Filtre | celui par défaut |

Règles : `CN=VoxEcho-Admins,CN=Users,DC=lab,DC=voxecho,DC=local` → **ADMIN**,
et `CN=VoxEcho-Auditeurs,CN=Users,DC=lab,DC=voxecho,DC=local` → **AUDITOR**.

Le DN exact d'un groupe se lit ainsi, et ne se devine pas — Samba range les
objets provisionnés dans `CN=Users`, là où un AD d'entreprise a souvent une
unité d'organisation dédiée :

```bash
docker exec $D samba-tool group show VoxEcho-Admins | grep ^dn:
```

## Pour recommencer

```bash
docker compose -f deploy/lab/samba-ad.yml down -v
```
