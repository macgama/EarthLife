export interface RandomNameOptions {
  country?: string; // e.g. 'fr', 'ch', 'de', 'es', 'it', 'gb', 'us', 'br', 'jp', 'in' or 'all'
  gender?: 'male' | 'female';
  count?: number;
}

export interface GeneratedPersonName {
  first: string;
  last: string;
  fullName: string;
  gender?: string;
  nat?: string;
}

// Map of user-friendly country/region names to randomuser.me nationality codes
export const NATIONALITY_MAP: Record<string, { label: string; natCode: string; flag: string }> = {
  all: { label: 'International / Mondial', natCode: 'fr,ch,de,es,it,gb,us,br,ca,dk,fi,ie,in,mx,nl,no,nz,rs,tr,ua', flag: '🌍' },
  fr: { label: 'France', natCode: 'fr', flag: '🇫🇷' },
  ch: { label: 'Suisse / Europe Centrale', natCode: 'ch,de,fr', flag: '🇨🇭' },
  de: { label: 'Allemagne', natCode: 'de', flag: '🇩🇪' },
  es: { label: 'Espagne / Amérique Latine', natCode: 'es,mx', flag: '🇪🇸' },
  it: { label: 'Italie', natCode: 'it', flag: '🇮🇹' },
  gb: { label: 'Royaume-Uni', natCode: 'gb', flag: '🇬🇧' },
  us: { label: 'États-Unis', natCode: 'us', flag: '🇺🇸' },
  br: { label: 'Brésil', natCode: 'br', flag: '🇧🇷' },
  in: { label: 'Inde', natCode: 'in', flag: '🇮🇳' },
  tr: { label: 'Turquie', natCode: 'tr', flag: '🇹🇷' }
};

// Local fallback lists in case network is offline
const FALLBACK_NAMES: Record<string, { maleFirst: string[]; femaleFirst: string[]; last: string[] }> = {
  fr: {
    maleFirst: ['Lucas', 'Hugo', 'Arthur', 'Louis', 'Gabriel', 'Léo', 'Paul', 'Antoine', 'Julien', 'Thomas', 'Nicolas', 'Mathieu', 'Alexandre', 'Maxime'],
    femaleFirst: ['Emma', 'Léa', 'Chloé', 'Manon', 'Camille', 'Sarah', 'Clara', 'Inès', 'Julie', 'Marion', 'Audrey', 'Elodie', 'Laura', 'Sophie'],
    last: ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia']
  },
  global: {
    maleFirst: ['John', 'Carlos', 'Marco', 'Hans', 'Liam', 'Oliver', 'Tariq', 'Hiroshi', 'Mateo', 'Dmitri', 'David', 'Vijay', 'Arthur', 'Sven'],
    femaleFirst: ['Elena', 'Sophia', 'Maria', 'Aisha', 'Yuki', 'Lucia', 'Astrid', 'Chloe', 'Isabella', 'Mei', 'Freja', 'Ananya', 'Camille', 'Olga'],
    last: ['Silva', 'Müller', 'Rossi', 'Kim', 'Tanaka', 'Patel', 'Smith', 'Schneider', 'Lopez', 'Ivanov', 'Novak', 'Dubois', 'Santos', 'Svensson']
  }
};

/**
 * Fetch real random names from the free RandomUser.me API by nationality/country.
 */
export async function fetchRandomNameFromApi(options: RandomNameOptions = {}): Promise<GeneratedPersonName> {
  const names = await fetchRandomNamesFromApi({ ...options, count: 1 });
  return names[0] || getRandomFallbackName(options);
}

/**
 * Fetch multiple random names from RandomUser API
 */
export async function fetchRandomNamesFromApi(options: RandomNameOptions = {}): Promise<GeneratedPersonName[]> {
  const count = options.count || 1;
  const countryKey = options.country || 'fr';
  const natInfo = NATIONALITY_MAP[countryKey] || NATIONALITY_MAP.all;
  const natCode = natInfo.natCode;

  let url = `https://randomuser.me/api/?results=${count}&inc=name,gender,nat&noinfo`;
  if (natCode && natCode !== 'all') {
    url += `&nat=${natCode}`;
  }
  if (options.gender) {
    url += `&gender=${options.gender}`;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s timeout limit

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }

    const data = await response.json();
    if (data && data.results && Array.isArray(data.results) && data.results.length > 0) {
      return data.results.map((item: any) => {
        const first = item.name.first.charAt(0).toUpperCase() + item.name.first.slice(1);
        const last = item.name.last.charAt(0).toUpperCase() + item.name.last.slice(1);
        return {
          first,
          last,
          fullName: `${first} ${last}`,
          gender: item.gender,
          nat: item.nat
        };
      });
    }
  } catch (err) {
    console.warn('[NameGenerator] API fetch failed or timed out, using fallback generator:', err);
  }

  // Fallback generation if network/API fails
  const list: GeneratedPersonName[] = [];
  for (let i = 0; i < count; i++) {
    list.push(getRandomFallbackName(options));
  }
  return list;
}

function getRandomFallbackName(options: RandomNameOptions = {}): GeneratedPersonName {
  const langKey = options.country && FALLBACK_NAMES[options.country] ? options.country : 'fr';
  const data = FALLBACK_NAMES[langKey] || FALLBACK_NAMES.global;

  const isFemale = options.gender === 'female' || (options.gender !== 'male' && Math.random() < 0.5);
  const firstPool = isFemale ? data.femaleFirst : data.maleFirst;
  const first = firstPool[Math.floor(Math.random() * firstPool.length)];
  const last = data.last[Math.floor(Math.random() * data.last.length)];

  return {
    first,
    last,
    fullName: `${first} ${last}`,
    gender: isFemale ? 'female' : 'male',
    nat: langKey.toUpperCase()
  };
}
