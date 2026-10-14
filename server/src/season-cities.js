// Villes annoncées de la saison : une par niveau, fixées avant l'ouverture et montrées en premier au menu (proposition : depuis le
// « choix libre » du 13 octobre, chaque joueur peut prendre une autre commune de son niveau). Liste vide : rien n'est proposé, la
// ville d'un niveau est celle que ses joueurs ont ouverte. Quand la commune annoncée est ouverte, elle garde le nom et le point
// d'ici ; une entrée mal formée est ignorée.
// Format : { facile: { key, name, lat, lon }, moyen: { … }, difficile: { … } }, avec `key` la clé de la commune telle que
// le jeu la calcule (celle de la fiche de la commune, même clé pour tous) et lat, lon un point de la commune.
export const ANNOUNCED_CITIES = {};
