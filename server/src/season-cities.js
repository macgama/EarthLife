// Villes annoncées de la saison : une par niveau, fixées avant l'ouverture et montrées au menu, où chaque joueur du niveau
// commence où il veut dans cette ville. Liste vide : la ville d'un niveau est celle de son premier joueur (première
// version). Une ville déjà posée dans un niveau l'emporte toujours sur cette liste, et une entrée mal formée est ignorée.
// Format : { facile: { key, name, lat, lon }, moyen: { … }, difficile: { … } }, avec `key` la clé de la commune telle que
// le jeu la calcule (celle de la fiche de la commune, même clé pour tous) et lat, lon un point de la commune.
export const ANNOUNCED_CITIES = {};
