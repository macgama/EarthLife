import React, { useEffect, useState, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, GeoJSON, Marker, Popup, useMap, useMapEvents, Tooltip, Circle, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { 
  Loader2, LogOut, Users, Mountain, Maximize2, Globe2, ChevronLeft, ChevronRight, 
  Layers, X, Map, MapPin, CloudSun, Sun, CloudRain, CloudSnow, Cloud, Wind, Droplets,
  Biohazard, ShieldAlert, Crosshair, Home, CheckCircle2, AlertTriangle, Users2,
  Play, Pause, FastForward, RefreshCw, Skull, HelpCircle, Building, Plus, ArrowLeft, Hammer,
  Trophy, Medal, Compass, Award, Sparkles, Clock, Swords, User
} from 'lucide-react';
import { QuotaNoticeBanner } from './components/QuotaNoticeBanner';
import { CharacterCard } from './components/survival/CharacterCard';
import { Auth } from './components/Auth';
import { CitySelector } from './components/CitySelector';
import { GameSetupWizard, PRESET_CHARACTERS, DIFFICULTY_LEVELS, SurvivorCharacter, DifficultyOption, getDifficultyFromSession } from './components/survival/GameSetupWizard';
import { getCharacterColor, CHARACTER_COLORS, TravelRoute, ActiveTravel, ActiveScavenge, SurvivorCharacter, applyMovementCost, applyTimeTick } from './lib/character';
import { GameLobby } from './components/survival/GameLobby';
import { UserProfileModal } from './components/UserProfileModal';
import { AdminModal } from './components/AdminModal';
import { CraftingModal } from './components/survival/CraftingModal';
import { MissionsModal } from './components/survival/MissionsModal';
import { AdjacentCitiesModal } from './components/survival/AdjacentCitiesModal';
import { StreetCombatModal } from './components/survival/StreetCombatModal';

import { 
  UserProgression, initializeUserProgression, fetchUserProgression, 
  updateUserXP, addCityBadgeToUser, getMaxSquadsForLevel 
} from './lib/progression';

import { StreetExplorerBar } from './components/StreetExplorerBar';

import { 
  subscribeToCityData, subscribeToCities, checkBuildingHQEligibility,
  subscribeToGameSession, createOrUpdateGameSession, subscribeToSessionPlayers, savePlayerProfile,
  subscribeToScenarioCityState, saveScenarioCityState, subscribeToSessionSquads, saveSquadProfile, SquadProfile,
  ensureUserProfile, subscribeUserProfile, saveSurvivorCharacter,
  calculateGameTimeMinutes, formatGameTime, isInvalidOrDistrictBoundary,
  fetchStreetOrAreaFeatures
} from './lib/api';
import { auth } from './lib/firebase';
import { signOut } from 'firebase/auth';
import { calculateGeoJSONAreaKm2 } from './lib/geo';
import { subscribeToGameRules, getGameRules } from './lib/gameRules';
import { fetchCurrentWeather, WeatherData } from './lib/weather';
import { CityData } from './types';
import { generateCityPopulationState, CityPopulationState, OutdoorZombieHorde, processNightlyInfectedIncursion } from './lib/population';
import { BuildingDetailModal } from './components/survival/BuildingDetailModal';
import { PoiDetailModal } from './components/survival/PoiDetailModal';
import { ScavengeSummaryModal } from './components/survival/ScavengeSummaryModal';
import { ScavengeToastOverlay, ActiveScavengeToast } from './components/survival/ScavengeToastOverlay';
import { ScavengeDiscoveryItem } from './lib/character';
import { getBuildingDetails, BuildingDetails } from './lib/buildingDetails';
import { CityResourceGauges } from './components/survival/CityResourceGauges';
import { CityGoalPanel } from './components/survival/CityGoalPanel';
import { FogOfWar, VisionPoint } from './components/survival/FogOfWar';
import { MapCenterer } from './components/survival/MapCenterer';

// Helper component to manage initial map view centering and zoom level
function MapViewController({ 
  data, 
  activeSquad, 
  selectedCityId, 
  isPanelCollapsed,
  characterToLocate
}: { 
  data: any; 
  activeSquad: any; 
  selectedCityId: string | null; 
  isPanelCollapsed: boolean;
  characterToLocate?: {lat: number, lon: number, id: string} | null;
}) {
  const map = useMap();
  const hasCenteredRef = useRef<string | null>(null);

  useEffect(() => {
    if (characterToLocate) {
      map.flyTo([characterToLocate.lat, characterToLocate.lon], 18, { animate: true, duration: 1.5 });
    }
  }, [characterToLocate, map]);

  useEffect(() => {
    if (!selectedCityId) return;

    const squadKey = activeSquad?.hqLat 
      ? `${selectedCityId}-hq-${activeSquad.squadId}-${activeSquad.hqLat}-${activeSquad.hqLon}` 
      : `${selectedCityId}-nohq`;

    if (hasCenteredRef.current === squadKey) return;

    // 1. If active squad has HQ coordinates, focus zoom directly on HQ
    if (activeSquad && activeSquad.hqLat && activeSquad.hqLon) {
      hasCenteredRef.current = squadKey;
      const zoom = 15.5;
      map.flyTo([activeSquad.hqLat, activeSquad.hqLon], zoom, {
        animate: true,
        duration: 1
      });
      return;
    }

    // 2. Otherwise, if GeoJSON data is available, fit bounds of the city with sidebar padding
    if (data && data.features && data.features.length > 0) {
      try {
        const bounds = L.geoJSON(data).getBounds();
        if (bounds.isValid()) {
          hasCenteredRef.current = squadKey;
          const leftPadding = isPanelCollapsed ? 40 : 420;
          map.fitBounds(bounds, {
            paddingTopLeft: [leftPadding, 40],
            paddingBottomRight: [40, 40],
            maxZoom: 15.5
          });
        }
      } catch (e) {
        // Ignore invalid geometry
      }
    }
  }, [data, activeSquad, selectedCityId, isPanelCollapsed, map]);

  return null;
}

// Helper component to trigger Leaflet resize recalculation when sidebar collapses/expands
function MapResizeHandler({ isPanelCollapsed }: { isPanelCollapsed: boolean }) {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
    const t1 = setTimeout(() => map.invalidateSize(), 100);
    const t2 = setTimeout(() => map.invalidateSize(), 320);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isPanelCollapsed, map]);
  return null;
}

// Helper component to track zoom level
function ZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMapEvents({
    zoomend: () => {
      onZoomChange(map.getZoom());
    }
  });
  
  useEffect(() => {
    onZoomChange(map.getZoom());
  }, [map, onZoomChange]);
  
  return null;
}

function MapClickHandler({
  selectedCityId,
  selectedCityName,
  onExploreLocation
}: {
  selectedCityId: string | null;
  selectedCityName: string | null;
  onExploreLocation: (lat: number, lon: number) => void;
}) {
  useMapEvents({
    click: (e) => {
      if (selectedCityId && selectedCityName) {
        onExploreLocation(e.latlng.lat, e.latlng.lng);
      }
    }
  });
  return null;
}

function renderWeatherIcon(code: number, isDay: boolean) {
  if (code === 0 || code === 1) {
    return isDay ? <Sun className="w-5 h-5 text-amber-400" /> : <Sun className="w-5 h-5 text-slate-300" />;
  }
  if (code === 2 || code === 3) {
    return <CloudSun className="w-5 h-5 text-sky-400" />;
  }
  if (code >= 51 && code <= 67) {
    return <CloudRain className="w-5 h-5 text-blue-400" />;
  }
  if (code >= 71 && code <= 86) {
    return <CloudSnow className="w-5 h-5 text-cyan-200" />;
  }
  return <Cloud className="w-5 h-5 text-slate-400" />;
}

function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3; // metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function MainApp() {
  const currentUser = auth.currentUser;

  // City & Geo state
  const [selectedCityId, setSelectedCityId] = useState<string | null>(null);
  const [selectedCityName, setSelectedCityName] = useState<string | null>(null);
  const [geoData, setGeoData] = useState<any>(null);
  const [cityDetails, setCityDetails] = useState<CityData | null>(null);
  const [allCities, setAllCities] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(14);
  const [cityStatus, setCityStatus] = useState<string>('ready');
  const [isPanelCollapsed, setIsPanelCollapsed] = useState<boolean>(false);
  const [showLegendModal, setShowLegendModal] = useState<boolean>(false);

  // Weather state
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState<boolean>(false);

  // User Profile & Progression state
  const [userProfile, setUserProfile] = useState<any | null>(null);
  const [progression, setProgression] = useState<UserProgression>(initializeUserProgression());
  const [showUserProfileModal, setShowUserProfileModal] = useState<boolean>(false);
  const [showAdminModal, setShowAdminModal] = useState<boolean>(false);
  const [showMissionsModal, setShowMissionsModal] = useState<boolean>(false);
  useEffect(() => {
    const unsub = subscribeToGameRules((rules) => {
      console.log("Game rules loaded:", rules);
    });
    return () => unsub();
  }, []);

  const [showAdjacentCitiesModal, setShowAdjacentCitiesModal] = useState<boolean>(false);
  const [showVictoryBanner, setShowVictoryBanner] = useState<boolean>(false);
  const isAdmin = currentUser?.email === 'gael.manigley@gmail.com';

  useEffect(() => {
    if (!currentUser) return;
    ensureUserProfile(currentUser);
    const unsub = subscribeUserProfile(currentUser.uid, (prof) => {
      setUserProfile(prof);
    });
    fetchUserProgression(currentUser.uid).then(prog => {
      setProgression(prog);
    });
    return () => unsub();
  }, [currentUser]);

  // Helper to handle awarding XP across the app
  const handleAwardXP = async (amount: number, reason: string) => {
    if (!currentUser) return;
    const { newProgression } = await updateUserXP(currentUser.uid, amount, reason, activeSessionId || undefined);
    setProgression(newProgression);
  };

  // Helper to handle mission claim
  const handleClaimMissionReward = async (missionId: string) => {
    if (!currentUser) return;
    const mission = progression.missions.find(m => m.id === missionId);
    if (!mission || mission.completed || mission.progress < mission.target) return;

    const xpReward = mission.xpReward;
    const updatedMissions = progression.missions.map(m => 
      m.id === missionId ? { ...m, completed: true } : m
    );

    const { newProgression } = await updateUserXP(currentUser.uid, xpReward, `Mission Réclamée: ${mission.title}`, activeSessionId || undefined);

    setProgression({
      ...newProgression,
      missions: updatedMissions,
      completedMissionIds: [...(progression.completedMissionIds || []), missionId]
    });
  };

  // Multiplayer Game Session & Setup state
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<any | null>(null);
  const [sessionPlayers, setSessionPlayers] = useState<any[]>([]);
  const [sessionSquads, setSessionSquads] = useState<any[]>([]);
  const [activeSquadId, setActiveSquadId] = useState<string | null>(null);
  const [pendingSquadName, setPendingSquadName] = useState<string>('Équipe 1');
  // Find current session player for max squads
  const mySessionPlayer = sessionPlayers.find(p => p.uid === currentUser?.uid);
  const maxSquadSlots = mySessionPlayer ? Math.max(1, mySessionPlayer.maxSquads || 1) : getMaxSquadsForLevel(progression.level);

  const [gameSetupMode, setGameSetupMode] = useState<'wizard' | 'choosing_hq' | 'in_game'>('wizard');
  
  // Game Time state (dynamic persistent real-time clock starting at Day 1 06:00 AM)
  const [gameTimeMinutes, setGameTimeMinutes] = useState<number>(6 * 60);

    
  // Game Setup parameters
  const [selectedScenario, setSelectedScenario] = useState<string>("Invasion de zombie suite à un virus");
  const [selectedDifficulty, setSelectedDifficulty] = useState<DifficultyOption>(DIFFICULTY_LEVELS[0]);
  const [userCharacters, setUserCharacters] = useState<SurvivorCharacter[]>(PRESET_CHARACTERS.slice(0, 5));

  // Active Scavenge Alerts & Summary Modal state
  const [scavengeToasts, setScavengeToasts] = useState<ActiveScavengeToast[]>([]);
  const [summaryScavenge, setSummaryScavenge] = useState<ActiveScavenge | null>(null);
  const [isSummaryModalOpen, setIsSummaryModalOpen] = useState<boolean>(false);
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);

  // Squads belonging to the current user in this scenario
  const mySquads = currentUser ? sessionSquads.filter(s => s.uid === currentUser.uid) : [];

  // Auto-select active squad or sync when mySquads change
  useEffect(() => {
    if (mySquads.length > 0) {
      if (!activeSquadId || !mySquads.some(s => s.squadId === activeSquadId)) {
        setActiveSquadId(mySquads[0].squadId);
      }
    }
  }, [mySquads, activeSquadId]);

  const activeSquad = mySquads.find(s => s.squadId === activeSquadId) || mySquads[0] || null;

  const visionPoints = useMemo<VisionPoint[]>(() => {
    if (gameSetupMode !== 'in_game') return [];
    const points: VisionPoint[] = [];
    
    // Aggregate vision from ALL squads in the session
    sessionSquads.forEach(sq => {
      // 1. Add HQ vision
      if (sq.hqLat && sq.hqLon) {
        points.push({ lat: sq.hqLat, lon: sq.hqLon, radius: getGameRules().visionRadiusMeters });
      }
      
      // 2. Add characters vision
      if (sq.characters) {
        try {
          const chars = typeof sq.characters === 'string' ? JSON.parse(sq.characters) : sq.characters;
          if (Array.isArray(chars)) {
            chars.forEach((c: any) => {
              const h = c.vitals?.sante || c.health || 85;
              if (h > 0) {
                points.push({
                  lat: c.lat || sq.hqLat || 0,
                  lon: c.lon || sq.hqLon || 0,
                  radius: getGameRules().visionRadiusMeters
                });
              }
            });
          }
        } catch(e) {}
      }
      
      // 3. Add unrecruited survivors vision
      if (sq.customBuildings) {
        Object.values(sq.customBuildings).forEach((bData: any) => {
          if (bData.hasUnrecruitedSurvivors && bData.lat && bData.lon) {
            points.push({ lat: bData.lat, lon: bData.lon, radius: getGameRules().visionRadiusMeters });
          }
        });
      }
    });

    return points;
  }, [gameSetupMode, sessionSquads]);

  const isPointVisible = (lat: number, lon: number) => {
    if (gameSetupMode !== 'in_game') return true;
    if (visionPoints.length === 0) return true;
    return visionPoints.some(vp => getDistance(vp.lat, vp.lon, lat, lon) <= vp.radius);
  };

  // When active squad changes, switch current city and load characters
  useEffect(() => {
    if (activeSquad) {
      if (activeSquad.cityId && activeSquad.cityId !== selectedCityId) {
        setSelectedCityId(activeSquad.cityId);
        setSelectedCityName(activeSquad.cityName);
      }
      if (activeSquad.characters) {
        try {
          const chars = typeof activeSquad.characters === 'string' ? JSON.parse(activeSquad.characters) : activeSquad.characters;
          if (Array.isArray(chars) && chars.length > 0) {
            setUserCharacters(chars);
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }, [activeSquad?.squadId, activeSquad?.characters]);
  
  const [exploringStatusMessage, setExploringStatusMessage] = useState<string | null>(null);

  const handleExploreLocation = async (lat: number, lon: number) => {
    if (!selectedCityId || !selectedCityName) return;
    setExploringStatusMessage(`🔍 Chargement de la rue/zone aux coordonnées (${lat.toFixed(3)}, ${lon.toFixed(3)})...`);
    try {
      const features = await fetchStreetOrAreaFeatures(selectedCityId, selectedCityName, lat, lon, 300);
      if (features.length > 0) {
        setExploringStatusMessage(`✨ Zone révélée : ${features.length} structures & axes générés !`);
      } else {
        setExploringStatusMessage(`Aucun bâtiment détecté dans cette rue/zone.`);
      }
    } catch (err) {
      console.warn("Map click explore failed:", err);
    } finally {
      setTimeout(() => setExploringStatusMessage(null), 3500);
    }
  };

  // HQ Candidate & Error state
  const [candidateHQ, setCandidateHQ] = useState<{
    feature: any;
    featureId: string;
    lat: number;
    lon: number;
    name: string;
    type: string;
    area: number;
    capacity: number;
  } | null>(null);

  // Inspected Building Detail Modal state
  const [inspectedBuildingData, setInspectedBuildingData] = useState<{
    details: BuildingDetails;
    bldgPop?: { survivors: number; indoorZombies: number };
  } | null>(null);
  const [inspectedPoiData, setInspectedPoiData] = useState<{
    details: BuildingDetails;
    feature: any;
  } | null>(null);
  const [hqErrorReason, setHqErrorReason] = useState<string | null>(null);

  // Searched buildings tracker state
  const [searchedBuildingIds, setSearchedBuildingIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('searched_buildings_list');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  const markBuildingAsSearched = (bldgId: string) => {
    if (!bldgId) return;
    setSearchedBuildingIds(prev => {
      if (prev.includes(bldgId)) return prev;
      const updated = [...prev, bldgId];
      try {
        localStorage.setItem('searched_buildings_list', JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
  };

  // Active noise/gunshot events rendered as acoustic propagation rings on the map
  const [activeNoiseEvents, setActiveNoiseEvents] = useState<Array<{
    id: string;
    lat: number;
    lon: number;
    radiusMeters: number;
    sourceName: string;
    decibels: number;
    createdAt: number;
  }>>([]);

  const [systemAlerts, setSystemAlerts] = useState<Array<{ id: string, message: string }>>([]);

  const triggerGunshotNoise = (weaponName = 'Pistolet 9mm', decibels = 120, radiusMeters = 300) => {
    const lat = activeSquad?.hqLat || 46.613;
    const lon = activeSquad?.hqLon || 6.794;
    const newEvent = {
      id: `gunshot-${Date.now()}`,
      lat: lat + (Math.random() - 0.5) * 0.0008,
      lon: lon + (Math.random() - 0.5) * 0.0008,
      radiusMeters,
      sourceName: `Tir de ${weaponName}`,
      decibels,
      createdAt: Date.now()
    };
    setActiveNoiseEvents(prev => [...prev.slice(-4), newEvent]);
  };

  // Selected street zombie horde for combat modal
  const [selectedHordeForCombat, setSelectedHordeForCombat] = useState<OutdoorZombieHorde | null>(null);

  // Inspected character for modal detail sheet
  const [inspectedCharacter, setInspectedCharacter] = useState<SurvivorCharacter | null>(null);
  const [characterToLocate, setCharacterToLocate] = useState<{lat: number, lon: number, id: string} | null>(null);

  // Character saving helper that updates React state and persists to Firestore
  const handleSaveCharacter = async (updatedChar: SurvivorCharacter) => {
    setUserCharacters(prev => {
      const next = prev.map(c => c.id === updatedChar.id ? updatedChar : c);
      if (activeSquad && activeSessionId) {
        saveSquadProfile(activeSessionId, {
          ...activeSquad,
          characters: next
        }).catch(console.error);
      }
      return next;
    });
    await saveSurvivorCharacter(updatedChar);
  };

  // Batch character saving helper
  const handleSaveCharacters = async (updatedChars: SurvivorCharacter[]) => {
    const updatedMap = new Map(updatedChars.map(c => [c.id, c]));
    setUserCharacters(prev => {
      const next = prev.map(c => updatedMap.get(c.id) || c);
      if (activeSquad && activeSessionId) {
        saveSquadProfile(activeSessionId, {
          ...activeSquad,
          characters: next
        }).catch(console.error);
      }
      return next;
    });
    for (const char of updatedChars) {
      await saveSurvivorCharacter(char);
    }
  };

  // Record a squad travel route for tactical map rendering
  const handleRecordTravelRoute = async (route: TravelRoute) => {
    if (!activeSquad || !activeSessionId) return;
    const currentRoutes = activeSquad.travelRoutes || [];
    const updatedRoutes = [route, ...currentRoutes.filter(r => Date.now() - r.timestamp < 24 * 3600 * 1000)].slice(0, 10);
    await saveSquadProfile(activeSessionId, {
      ...activeSquad,
      travelRoutes: updatedRoutes
    });
  };

  // Updates city infected counts, zombies killed, outdoor hordes, and persists to Firestore
  const handleCombatInfectedKilled = async (zombiesKilled: number, buildingId?: string, outdoorHordeId?: string) => {
    if (!syncedCityPopulationState) return;

    const updatedState: CityPopulationState = {
      ...syncedCityPopulationState,
      zombiesKilled: (syncedCityPopulationState.zombiesKilled || 0) + zombiesKilled,
      totalInfected: Math.max(0, (syncedCityPopulationState.totalInfected || 0) - zombiesKilled),
    };

    if (buildingId) {
      updatedState.indoorInfected = Math.max(0, (syncedCityPopulationState.indoorInfected || 0) - zombiesKilled);
      if (updatedState.buildingPopulations && updatedState.buildingPopulations[buildingId]) {
        const bldg = updatedState.buildingPopulations[buildingId];
        updatedState.buildingPopulations = {
          ...updatedState.buildingPopulations,
          [buildingId]: {
            ...bldg,
            indoorZombies: Math.max(0, bldg.indoorZombies - zombiesKilled)
          }
        };
      }
    } else if (outdoorHordeId) {
      updatedState.outdoorInfected = Math.max(0, (syncedCityPopulationState.outdoorInfected || 0) - zombiesKilled);
      if (updatedState.outdoorHordes) {
        updatedState.outdoorHordes = updatedState.outdoorHordes.map(h => {
          if (h.id === outdoorHordeId) {
            const newCount = Math.max(0, h.count - zombiesKilled);
            return newCount > 0 ? { ...h, count: newCount } : null;
          }
          return h;
        }).filter(Boolean) as OutdoorZombieHorde[];
      }
    }

    setSyncedCityPopulationState(updatedState);

    if (activeSessionId && selectedCityId) {
      await saveScenarioCityState(activeSessionId, selectedCityId, updatedState);
    }
  };

  // City Selector Modal toggle
  const [showCitySelectorModal, setShowCitySelectorModal] = useState<boolean>(false);
  const [showCraftingModal, setShowCraftingModal] = useState<boolean>(false);

  const isZoomedOut = zoomLevel < 15;

  // Synced scenario city population state (stored in Firestore per scenario game session)
  const [syncedCityPopulationState, setSyncedCityPopulationState] = useState<CityPopulationState | null>(null);

  // Subscribe to or initialize scenario city population state in Firestore
  useEffect(() => {
    if (!selectedCityId || !activeSessionId) {
      setSyncedCityPopulationState(null);
      return;
    }

    const unsub = subscribeToScenarioCityState(activeSessionId, selectedCityId, (persistedState) => {
      const effectiveDifficulty = getDifficultyFromSession(activeSession);

      if (persistedState && persistedState.buildingPopulations && persistedState.outdoorHordes) {
        const basePop = persistedState.basePopulation || cityDetails?.population || 500;
        const expectedInfected = Math.round((basePop * effectiveDifficulty.infected) / 100);
        const currentInfected = persistedState.totalInfected;

        const hasMissingHordes = persistedState.outdoorHordes.length === 0 && persistedState.outdoorInfected > 0;
        const hasMissingBuildings = Object.keys(persistedState.buildingPopulations).length === 0 && persistedState.indoorInfected > 0;
        const needsRegeneration = Math.abs(currentInfected - expectedInfected) > 5 || hasMissingHordes || hasMissingBuildings;

        // If persistedState infected count deviates or it is missing expected features, recalculate!
        if (cityStatus === 'ready' && geoData && geoData.features && geoData.features.length > 0 && needsRegeneration) {
          const regeneratedState = generateCityPopulationState(
            geoData,
            cityDetails?.population,
            effectiveDifficulty,
            userCharacters.length || 5
          );
          setSyncedCityPopulationState(regeneratedState);
          saveScenarioCityState(activeSessionId, selectedCityId, regeneratedState).catch(err => {
            console.error("Failed to update scenario city state in Firestore:", err);
          });
        } else {
          setSyncedCityPopulationState(persistedState);
        }
      } else {
        // First time this city is loaded in the scenario: generate & persist to Firestore
        if (cityStatus === 'ready' && geoData && geoData.features && geoData.features.length > 0) {
          const generatedState = generateCityPopulationState(
            geoData,
            cityDetails?.population,
            effectiveDifficulty,
            userCharacters.length || 5
          );
          setSyncedCityPopulationState(generatedState);
          saveScenarioCityState(activeSessionId, selectedCityId, generatedState).catch(err => {
            console.error("Failed to save scenario city state to Firestore:", err);
          });
        }
      }
    });

    return () => unsub();
  }, [activeSessionId, selectedCityId, geoData, cityDetails?.population, activeSession, userCharacters.length, cityStatus]);

  const cityPopulationState = syncedCityPopulationState;

  // Subscribe to multiplayer session, players & squads
  useEffect(() => {
    if (!activeSessionId) return;

    const unsubSession = subscribeToGameSession(activeSessionId, (session) => {
      setActiveSession(session);
      if (session) {
        if (session.scenario) setSelectedScenario(session.scenario);
        const diff = getDifficultyFromSession(session);
        setSelectedDifficulty(diff);
      }
    });

    const unsubPlayers = subscribeToSessionPlayers(activeSessionId, (players) => {
      setSessionPlayers(players);
    });

    const unsubSquads = subscribeToSessionSquads(activeSessionId, (squads) => {
      setSessionSquads(squads);
    });

    return () => {
      unsubSession();
      unsubPlayers();
      unsubSquads();
    };
  }, [activeSessionId]);

  // Check if current player already has a profile in the session
  const myPlayerProfile = currentUser ? sessionPlayers.find(p => p.uid === currentUser.uid) : null;

  // Sync city & weather
  useEffect(() => {
    let lat = cityDetails?.lat;
    let lon = cityDetails?.lon;

    if ((!lat || !lon) && geoData && geoData.features && geoData.features.length > 0) {
      try {
        const bounds = L.geoJSON(geoData).getBounds();
        const center = bounds.getCenter();
        lat = center.lat;
        lon = center.lng;
      } catch (e) {
        // ignore
      }
    }

    if (lat && lon) {
      setWeatherLoading(true);
      fetchCurrentWeather(lat, lon).then(data => {
        setWeather(data);
        setWeatherLoading(false);
      });
    } else {
      setWeather(null);
      setWeatherLoading(false);
    }
  }, [cityDetails, geoData]);

  // Subscribe to Firestore cities list
  useEffect(() => {
    const unsubscribe = subscribeToCities((data) => {
      setAllCities(data);
    });
    return () => unsubscribe();
  }, []);

  // Subscribe to active city data
  useEffect(() => {
    if (!selectedCityId) {
      setGeoData(null);
      setCityDetails(null);
      setLoading(false);
      return;
    }
    
    setLoading(true);
    setError(null);

    const safetyTimer = setTimeout(() => {
      setLoading(false);
    }, 4000);
    
    const unsubscribe = subscribeToCityData(selectedCityId, (data, status, details) => {
      setGeoData(data);
      setCityStatus(status);
      if (details) {
        setCityDetails(details);
      }
      
      // Stop initial loading screen as soon as city details or status is ready, or features arrive
      if (status === 'ready' || details || (data && data.features && data.features.length > 0)) {
        setLoading(false);
      }
      
      if (status === 'error') {
        setError("Erreur lors de l'importation de la ville.");
        setLoading(false);
      }
    });

    return () => {
      clearTimeout(safetyTimer);
      unsubscribe();
    };
  }, [selectedCityId]);

  const [lastNightIncursionDay, setLastNightIncursionDay] = useState<number>(0);

  // Persistent Continuous Real-Time Scenario Clock (1 in-game minute per 10 real seconds)
  useEffect(() => {
    if (gameSetupMode === 'wizard') return;

    // Determine the scenario start timestamp
    const startedAt = activeSession?.startedAtTimestamp || Date.now();

    const updateClock = () => {
      const currentMinutes = calculateGameTimeMinutes(startedAt);
      setGameTimeMinutes(currentMinutes);

      const currentDay = Math.floor(currentMinutes / (24 * 60));

      // Trigger nightly incursion if day advanced and state is ready
      if (lastNightIncursionDay === 0) {
        setLastNightIncursionDay(currentDay);
      } else if (currentDay > lastNightIncursionDay && cityPopulationState && activeSessionId && selectedCityId) {
        setLastNightIncursionDay(currentDay);

        if ((cityPopulationState.cityFortification ?? 15) < 80) {
          const { updatedState, reportMessage } = processNightlyInfectedIncursion(
            cityPopulationState,
            selectedDifficulty.id
          );
          setSyncedCityPopulationState(updatedState);
          saveScenarioCityState(activeSessionId, selectedCityId, updatedState).catch(console.error);
          console.log(reportMessage);
          
          const alertId = `night-${currentDay}-${Date.now()}`;
          setSystemAlerts(prev => {
            // Keep maximum of 5 alerts
            const updated = [...prev, { id: alertId, message: reportMessage }];
            return updated.slice(-5);
          });
          
          setTimeout(() => {
            setSystemAlerts(prev => prev.filter(a => a.id !== alertId));
          }, 15000);
        }
      }
    };

    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, [activeSession, gameSetupMode, lastNightIncursionDay, cityPopulationState, activeSessionId, selectedCityId, selectedDifficulty.id]);

  const handleFortifyCityWithPNJ = async (character: SurvivorCharacter) => {
    if (!cityPopulationState || !activeSessionId || !selectedCityId) return;

    const bricolage = character.skills?.bricolage ?? 50;
    const mecanique = character.skills?.mecanique ?? 50;
    const force = character.attributes?.force ?? 50;

    // Calculate fortification boost (2% to 5%)
    const boost = Math.max(2, Math.min(5, Math.round((bricolage * 0.02) + (mecanique * 0.02) + (force * 0.01))));
    const currentFortification = cityPopulationState.cityFortification ?? 15;
    const newFortification = Math.min(100, currentFortification + boost);

    const isPacified = newFortification >= 80 && cityPopulationState.totalInfected === 0;

    const updatedState: CityPopulationState = {
      ...cityPopulationState,
      cityFortification: newFortification,
      isPacified
    };

    setSyncedCityPopulationState(updatedState);
    await saveScenarioCityState(activeSessionId, selectedCityId, updatedState).catch(console.error);

    // Award XP for fortification
    if (currentUser?.uid) {
      updateUserXP(currentUser.uid, 10, 'Fortification de la ville par PNJ', activeSessionId || undefined).then(({ newProgression }) => {
        setProgression(newProgression);
      });
    }

    // Award City Pacification Badge if 100% cleared and fortified >= 80%
    if (isPacified && currentUser?.uid && selectedCityName) {
      addCityBadgeToUser(currentUser.uid, selectedCityName).then(({ newProgression, badgeAdded }) => {
        if (badgeAdded) {
          setProgression(newProgression);
          setShowVictoryBanner(true);
        }
      });
    }
  };

  const formatGameTime = (minutes: number) => {
    const d = Math.floor(minutes / (24 * 60));
    const h = Math.floor((minutes % (24 * 60)) / 60);
    const m = Math.floor(minutes % 60);
    return `Jour ${d + 1} - ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  const handleLogout = () => {
    signOut(auth);
  };

  // Launch session from wizard
  const handleLaunchGameFromWizard = async (setupData: {
    squadName: string;
    scenario: string;
    difficulty: DifficultyOption;
    selectedCharacters: SurvivorCharacter[];
    startingCity: CityData;
  }) => {
    setSelectedScenario(setupData.scenario);
    setSelectedDifficulty(setupData.difficulty);
    setUserCharacters(setupData.selectedCharacters);
    setSelectedCityId(setupData.startingCity.id);
    setSelectedCityName(setupData.startingCity.name);
    setPendingSquadName(setupData.squadName);

    if (!activeSessionId) return;

    // If no active session or user is host, create session
    if (!activeSession && currentUser) {
      await createOrUpdateGameSession({
        sessionId: activeSessionId,
        scenario: setupData.scenario,
        difficulty: setupData.difficulty.id,
        infectedPercent: setupData.difficulty.infected,
        survivorsPercent: setupData.difficulty.survivors,
        hostUid: currentUser.uid,
        hostEmail: currentUser.email || 'Anonyme',
        status: 'active'
      });
    }

    // Move to HQ selection on the map!
    setGameSetupMode('choosing_hq');
    setCandidateHQ(null);
    setHqErrorReason(null);
  };

  // Confirm HQ selection
  const handleConfirmHQ = async () => {
    if (!candidateHQ || !selectedCityId || !selectedCityName || !currentUser || !activeSessionId) return;

    const squadId = `squad_${currentUser.uid}_${Date.now()}`;

    await saveSquadProfile(activeSessionId, {
      squadId,
      uid: currentUser.uid,
      email: currentUser.email || 'Joueur',
      squadName: pendingSquadName || `Équipe ${mySquads.length + 1}`,
      cityId: selectedCityId,
      cityName: selectedCityName,
      hqFeatureId: candidateHQ.featureId,
      hqName: candidateHQ.name,
      hqLat: candidateHQ.lat,
      hqLon: candidateHQ.lon,
      hqGeoJson: JSON.stringify(candidateHQ.feature),
      characters: userCharacters,
      maxCapacity: candidateHQ.capacity || 5
    });

    await savePlayerProfile(activeSessionId, {
      uid: currentUser.uid,
      email: currentUser.email || 'Joueur',
      cityId: selectedCityId,
      cityName: selectedCityName,
      hqFeatureId: candidateHQ.featureId,
      hqName: candidateHQ.name,
      hqLat: candidateHQ.lat,
      hqLon: candidateHQ.lon,
      hqGeoJson: JSON.stringify(candidateHQ.feature),
      characters: userCharacters
    });

    if (!activeSession?.startedAtTimestamp) {
      await createOrUpdateGameSession({
        sessionId: activeSessionId,
        scenario: activeSession?.scenario || selectedScenario,
        difficulty: activeSession?.difficulty || selectedDifficulty.id,
        infectedPercent: activeSession?.infectedPercent || selectedDifficulty.infected,
        survivorsPercent: activeSession?.survivorsPercent || selectedDifficulty.survivors,
        hostUid: activeSession?.hostUid || currentUser.uid,
        hostEmail: activeSession?.hostEmail || currentUser.email || 'Anonyme',
        status: 'active',
        startedAtTimestamp: Date.now()
      });
    }

    setActiveSquadId(squadId);
    setGameSetupMode('in_game');
    setMapCenter([candidateHQ.lat, candidateHQ.lon]);
  };

  // 1s Ticker for active travels and scavenges progression
  const [nowTick, setNowTick] = useState<number>(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Monitor active travels & scavenges and update squad state upon completion
  useEffect(() => {
    if (!activeSquad || !activeSessionId) return;

    const now = Date.now();
    const currentTravels = activeSquad.activeTravels || [];
    const completedTravels = currentTravels.filter(t => (now - t.startTime) >= t.durationSeconds * 1000);
    const remainingTravels = currentTravels.filter(t => (now - t.startTime) < t.durationSeconds * 1000);

    const currentScavenges = activeSquad.activeScavenges || [];
    const completedScavenges = currentScavenges.filter(s => (now - s.startTime) >= s.durationSeconds * 1000);
    const remainingScavenges = currentScavenges.filter(s => (now - s.startTime) < s.durationSeconds * 1000);

    // 1. Live Discovery Alerts during active scavenges
    let mutatedScavenges = false;
    const updatedScavengesList = currentScavenges.map(scavenge => {
      const elapsedSec = Math.floor((now - scavenge.startTime) / 1000);
      const discoveries = scavenge.discoveries || [];
      let updatedDiscoveries = [...discoveries];
      let discoveriesChanged = false;

      updatedDiscoveries.forEach((disc) => {
        if (!disc.notified && disc.secondOffset <= elapsedSec && elapsedSec < scavenge.durationSeconds) {
          disc.notified = true;
          discoveriesChanged = true;

          // Trigger live alert toast
          const toastId = `toast-${scavenge.id}-${disc.id}`;
          setScavengeToasts(prev => {
            if (prev.some(t => t.id === toastId)) return prev;
            return [...prev, { id: toastId, buildingName: scavenge.buildingName, discovery: disc }];
          });

          // Auto-remove toast after 8 seconds
          setTimeout(() => {
            setScavengeToasts(prev => prev.filter(t => t.id !== toastId));
          }, 8000);
        }
      });

      if (discoveriesChanged) {
        mutatedScavenges = true;
        return { ...scavenge, discoveries: updatedDiscoveries };
      }
      return scavenge;
    });

    // 2. Open Completion Summary Modal if a scavenge just finished
    if (completedScavenges.length > 0) {
      const lastCompleted = completedScavenges[completedScavenges.length - 1];
      setSummaryScavenge(lastCompleted);
      setIsSummaryModalOpen(true);
    }

    if (completedTravels.length === 0 && completedScavenges.length === 0 && !mutatedScavenges) return;

    let updatedCharacters = [...userCharacters];
    completedTravels.forEach(t => {
      updatedCharacters = updatedCharacters.map(char => {
        if (t.characterIds.includes(char.id)) {
          const updatedC = {
            ...char,
            locationType: 'building',
            buildingId: t.buildingId,
            buildingName: t.buildingName,
            lat: t.toLat,
            lon: t.toLon,
            vitals: {
              ...char.vitals,
              fatigue: Math.min(100, (char.vitals?.fatigue || 0) + (t.fatigueCost || 5)),
              endurance: Math.max(0, (char.vitals?.endurance || 100) - (t.enduranceCost || 5))
            }
          };
          saveSurvivorCharacter(updatedC);
          return updatedC;
        }
        return char;
      });
    });

    const updatedCustomBuildings = { ...(activeSquad.customBuildings || {}) };
    completedScavenges.forEach(s => {
      markBuildingAsSearched(s.buildingId);
      
      const survivors = (s.discoveries || []).filter(d => d.type === 'survivor');
      const hasUnrecruitedSurvivors = survivors.length > 0;

      updatedCustomBuildings[s.buildingId] = {
        ...(updatedCustomBuildings[s.buildingId] || {}),
        reconPercent: 100,
        hasUnrecruitedSurvivors,
        lat: s.lat,
        lon: s.lon
      };
    });

    const finalScavengesInSquad = updatedScavengesList.filter(s => (now - s.startTime) < s.durationSeconds * 1000);

    const newSquad: SquadProfile = {
      ...activeSquad,
      characters: updatedCharacters,
      customBuildings: updatedCustomBuildings,
      activeTravels: remainingTravels,
      activeScavenges: finalScavengesInSquad
    };

    setUserCharacters(updatedCharacters);
    saveSquadProfile(activeSessionId, newSquad);
  }, [nowTick]);

  const handleDismissScavengeToast = (id: string) => {
    setScavengeToasts(prev => prev.filter(t => t.id !== id));
  };

  const handleRecruitFromScavenge = async (survivor: SurvivorCharacter) => {
    setUserCharacters(prev => [...prev, survivor]);
    await saveSurvivorCharacter(survivor);
    
    if (activeSquad && summaryScavenge && activeSessionId) {
      const bId = summaryScavenge.buildingId;
      const updatedCustomBuildings = { ...(activeSquad.customBuildings || {}) };
      if (updatedCustomBuildings[bId]) {
        updatedCustomBuildings[bId] = {
          ...updatedCustomBuildings[bId],
          hasUnrecruitedSurvivors: false
        };
        const updatedSquad = { ...activeSquad, customBuildings: updatedCustomBuildings };
        saveSquadProfile(activeSessionId, updatedSquad);
      }
    }
  };

  const handleCollectLootFromScavenge = (items: ScavengeDiscoveryItem[]) => {
    if (userCharacters.length === 0) return;
    const firstChar = userCharacters[0];
    const existingInv = firstChar.inventory || [];
    const updatedInv = [...existingInv];

    items.forEach(item => {
      const match = updatedInv.find(i => i.name === item.name);
      if (match) {
        match.quantity += item.quantity;
      } else {
        updatedInv.push({ id: item.id, name: item.name, icon: item.icon, quantity: item.quantity, weight: item.weight });
      }
    });

    const updatedChar = { ...firstChar, inventory: updatedInv };
    setUserCharacters(prev => prev.map(c => c.id === firstChar.id ? updatedChar : c));
    saveSurvivorCharacter(updatedChar);
  };

  const handleStartTravel = async (travel: ActiveTravel) => {
    if (!activeSquad || !activeSessionId) return;

    // Clean undefined values from travel object
    const cleanTravel = JSON.parse(JSON.stringify(travel));

    // Update characters to mark them as busy
    const gameRulesConfig = getGameRules();
    const travelGameMinutes = Math.ceil(travel.durationSeconds / gameRulesConfig.realSecondsPerGameMinute);
    const busyUntil = gameTimeMinutes + travelGameMinutes;

    let updatedChars = [...userCharacters];
    travel.characterIds.forEach(charId => {
      const charIndex = updatedChars.findIndex(c => c.id === charId);
      if (charIndex >= 0) {
        updatedChars[charIndex] = {
          ...updatedChars[charIndex],
          busyUntilMinute: busyUntil,
          currentActionName: `Déplacement vers ${travel.toName}`
        };
        saveSurvivorCharacter(updatedChars[charIndex]); // Also save globally just in case
      }
    });

    setUserCharacters(updatedChars);

    const updatedTravels = [...(activeSquad.activeTravels || []), cleanTravel];
    const updatedSquad: SquadProfile = {
      ...activeSquad,
      characters: updatedChars, // Save chars inside the squad profile
      activeTravels: updatedTravels
    };

    await saveSquadProfile(activeSessionId, updatedSquad);
  };

  const handleStartScavenge = async (scavenge: ActiveScavenge) => {
    if (!activeSquad || !activeSessionId) return;

    // Clean undefined values from scavenge object
    const cleanScavenge = JSON.parse(JSON.stringify(scavenge));

    // Update characters to mark them as busy
    const gameRulesConfig = getGameRules();
    const scavengeGameMinutes = Math.ceil(scavenge.durationSeconds / gameRulesConfig.realSecondsPerGameMinute);
    const busyUntil = gameTimeMinutes + scavengeGameMinutes;

    let updatedChars = [...userCharacters];
    scavenge.characterIds.forEach(charId => {
      const charIndex = updatedChars.findIndex(c => c.id === charId);
      if (charIndex >= 0) {
        updatedChars[charIndex] = {
          ...updatedChars[charIndex],
          busyUntilMinute: busyUntil,
          currentActionName: `Fouille de ${scavenge.buildingName}`
        };
        saveSurvivorCharacter(updatedChars[charIndex]);
      }
    });

    setUserCharacters(updatedChars);

    const updatedScavenges = [...(activeSquad.activeScavenges || []), cleanScavenge];
    const updatedSquad: SquadProfile = {
      ...activeSquad,
      characters: updatedChars,
      activeScavenges: updatedScavenges
    };

    await saveSquadProfile(activeSessionId, updatedSquad);
  };

  // Map Feature Styling
  const styleFeature = (feature: any) => {
    const isLine = feature.geometry && (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString');
    const isPoint = feature.geometry && feature.geometry.type === 'Point';

    if (isPoint) {
      if (gameSetupMode === 'choosing_hq') {
        return {
          radius: 0,
          opacity: 0,
          fillOpacity: 0,
          interactive: false
        };
      }
      return {
        radius: isZoomedOut ? 0 : 5,
        fillColor: '#f43f5e',
        color: '#ffffff',
        weight: isZoomedOut ? 0 : 1.5,
        opacity: isZoomedOut ? 0 : 1,
        fillOpacity: isZoomedOut ? 0 : 0.9,
        fill: true,
        interactive: !isZoomedOut,
      };
    }

    // Candidate HQ Highlight
    if (candidateHQ && candidateHQ.feature === feature) {
      return {
        color: '#10b981',
        weight: 3.5,
        fillColor: '#34d399',
        fillOpacity: 0.85,
        fill: true,
        interactive: true,
      };
    }

    const p = feature.properties || {};
    let isClickable = isClickableStructureOrPOI(feature);

    if (gameSetupMode === 'choosing_hq') {
      const hqCheck = checkBuildingHQEligibility(feature);
      isClickable = hqCheck.isEligible;
    }

    const isBoundaryOrAdmin = Boolean(
      p.admin_level || 
      p.boundary || 
      p.border_type || 
      p.type === 'boundary' || 
      ['district', 'county', 'canton', 'state', 'region', 'municipality', 'commune', 'locality'].includes(p.place) ||
      (p.name && !p.building && !p.amenity && !p.shop && !p.landuse && !p.natural && !p.highway && !p.waterway && !p.railway)
    );

    if (isBoundaryOrAdmin) {
      if (isInvalidOrDistrictBoundary(feature)) {
        return {
          fill: false,
          stroke: false,
          opacity: 0,
          fillOpacity: 0,
          interactive: false
        };
      }
      return {
        color: '#ffffff',
        weight: 1.5,
        dashArray: '6, 6',
        fill: false,
        interactive: false,
      };
    }
    
    let color = '#334155';
    let fillColor = 'transparent';
    let fillOpacity = 0.1;
    let weight = 1;
    let fill = false;

    if (feature.properties) {
      const p = feature.properties;
      
      // Check if feature is a building or POI structure
      const isStructure = (p.building && p.building !== 'no' && p.building !== 'false') || 
                          !!p.amenity || !!p.shop || !!p.office || !!p.craft || !!p.tourism || 
                          !!p.historic || !!p.healthcare || !!p.emergency || !!p.public || 
                          !!p.man_made || feature.type === 'structure' || feature.type === 'poi';

      if (isStructure) {
        const fId = feature.id || feature.properties?.id || feature.properties?.['@id'] || (feature.properties?.osm_id ? `way/${feature.properties.osm_id}` : '') || `bldg-${feature.properties?.name ? feature.properties.name.replace(/\s+/g, '-').toLowerCase() : ''}`;
        const isHQ = fId === activeSquad?.hqFeatureId;
        const bState = activeSquad?.customBuildings?.[fId];
        const reconVal = bState?.reconPercent ?? 0;

        // A structure is ONLY green if it is HQ OR its search/recon percentage is > 0
        const isActiveScavenge = activeSquad?.activeScavenges?.some(s => s.buildingId === fId);
        const hasCharactersInside = activeSquad?.characters?.some(c => c.locationType === 'building' && c.buildingId === fId);
        const isSecured = reconVal === 100 && (bState?.infectedCount || 0) === 0 && (bState?.fortificationLevel || 0) >= 80;

        if (gameSetupMode === 'choosing_hq') {
          const hqCheck = checkBuildingHQEligibility(feature);
          if (hqCheck.isEligible) {
            fillColor = '#3b82f6'; // Bright blue for eligible HQ
            color = '#60a5fa';
            fillOpacity = 0.5;
            fill = true;
            weight = 2;
          } else {
            fillColor = '#0f172a'; // Very dark, barely visible
            color = '#1e293b';
            fillOpacity = 0.2;
            fill = true;
            weight = 1;
          }
        } else if (isHQ) {
          fillColor = '#059669'; // Emerald for HQ
          color = '#34d399';
          fillOpacity = 0.65;
          fill = true;
          weight = 2;
        } else if (isActiveScavenge || (hasCharactersInside && reconVal < 100)) {
          fillColor = '#ca8a04'; // Yellow for in progress / characters inside
          color = '#fde047';
          fillOpacity = 0.65;
          fill = true;
          weight = 2;
        } else if (isSecured) {
          fillColor = '#ea580c'; // Orange for 100% secured
          color = '#fdba74';
          fillOpacity = 0.65;
          fill = true;
          weight = 2;
        } else if (reconVal > 0) {
          fillColor = '#475569'; // Same as unsearched, or slightly different? The prompt didn't specify. I'll make it slate but slightly lighter
          color = '#94a3b8';
          fillOpacity = 0.6;
          fill = true;
          weight = 1.5;
        } else {
          fillColor = '#334155'; // Darker Slate for unsearched buildings (recon = 0)
          color = '#64748b';
          fillOpacity = 0.6;
          fill = true;
          weight = 1.5;
        }
      } else if (p.natural === 'water' || p.waterway || p.water || p.leisure === 'swimming_pool' || p.amenity === 'fountain') {
        fillColor = '#0369a1';
        color = isLine ? fillColor : 'transparent';
        fillOpacity = 0.3;
        fill = !isLine;
        if (isLine) weight = 2;
      } else if (p.landuse === 'forest' || p.natural === 'wood') {
        fillColor = '#047857';
        color = isLine ? fillColor : 'transparent';
        fillOpacity = 0.2;
        fill = !isLine;
      } else if (['grass', 'meadow', 'village_green'].includes(p.landuse) || ['park', 'pitch', 'garden'].includes(p.leisure)) {
        fillColor = '#4d7c0f';
        color = isLine ? fillColor : 'transparent';
        fillOpacity = 0.2;
        fill = !isLine;
      } else if (['farmland', 'farmyard', 'orchard', 'vineyard'].includes(p.landuse)) {
        fillColor = '#b45309';
        color = isLine ? fillColor : 'transparent';
        fillOpacity = 0.15;
        fill = !isLine;
      } else if (p.landuse === 'residential') {
        fillColor = '#1e293b';
        color = isLine ? fillColor : 'transparent';
        fillOpacity = 0.1;
        fill = !isLine;
      } else if (['commercial', 'industrial', 'retail'].includes(p.landuse)) {
        fillColor = '#334155';
        color = isLine ? fillColor : 'transparent';
        fillOpacity = 0.1;
        fill = !isLine;
      } else if (['sand', 'bare_rock', 'scree'].includes(p.natural)) {
        fillColor = '#334155';
        color = isLine ? fillColor : 'transparent';
        fillOpacity = 0.2;
        fill = !isLine;
      } else if (p.highway) {
        let dashArray = undefined;
        if (['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'].includes(p.highway)) {
          color = '#f87171';
          weight = 3;
        } else if (['secondary', 'secondary_link', 'tertiary', 'tertiary_link'].includes(p.highway)) {
          color = '#fb923c';
          weight = 2;
        } else if (['residential', 'unclassified', 'service', 'living_street'].includes(p.highway)) {
          color = '#d1d5db';
          weight = 1.5;
        } else {
          color = '#9ca3af';
          weight = 1;
          if (['track', 'path', 'footway', 'pedestrian', 'cycleway'].includes(p.highway)) {
            dashArray = '4, 4';
          }
        }
        fillColor = color;
        fillOpacity = 0.15;
        fill = !isLine;
        
        if (isLine && dashArray) return { color, weight, dashArray, fill: false, interactive: false };
      } else if (p.railway) {
        color = '#a3a3a3';
        weight = 2;
        fillColor = color;
        fillOpacity = 0.15;
        fill = !isLine;
        if (isLine) return { color, weight, dashArray: '8, 8', fill: false, interactive: false };
      }
    }

    // Default clickable override for generic POIs that are not buildings/water/etc
    if (isClickable && !fill) {
      if (gameSetupMode === 'choosing_hq') {
        color = 'transparent';
        fillColor = 'transparent';
        fillOpacity = 0;
        fill = false;
        weight = 0;
      } else {
        color = '#06b6d4';
        fillColor = '#22d3ee';
        fillOpacity = 0.3;
        fill = true;
        weight = 1.5;
      }
    }

    return { color, weight, fillColor, fillOpacity, fill, interactive: isClickable };
  };

  const pointToLayer = (feature: any, latlng: any) => {
    if (gameSetupMode === 'choosing_hq') {
      return L.circleMarker(latlng, { radius: 0, opacity: 0, fillOpacity: 0 });
    }
    return L.circleMarker(latlng, {
      radius: isZoomedOut ? 0 : 6,
      fillColor: '#f43f5e',
      color: '#ffffff',
      weight: isZoomedOut ? 0 : 1.5,
      opacity: isZoomedOut ? 0 : 1,
      fillOpacity: isZoomedOut ? 0 : 0.85
    });
  };

  const isClickableStructureOrPOI = (feature: any): boolean => {
    if (!feature || !feature.properties) return false;
    const p = feature.properties;

    // Exclude pure road, railway or waterway lines
    const isLine = feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString';
    if (isLine) return false;

    // Exclude administrative boundaries, places, districts, etc.
    if (
      p.admin_level || 
      p.boundary || 
      p.border_type || 
      p.type === 'boundary' || 
      ['district', 'county', 'canton', 'state', 'region', 'municipality', 'commune', 'locality'].includes(p.place) ||
      (p.name && !p.building && !p.amenity && !p.shop && !p.craft && !p.office && !p.tourism && !p.historic && !p.leisure && !p.man_made && !p.healthcare && !p.emergency && !p.public)
    ) {
      return false;
    }

    // Is it explicitly marked as a structure or POI?
    if (feature.type === 'structure' || feature.type === 'poi') return true;

    // Check building property
    if (p.building && p.building !== 'no' && p.building !== 'false') return true;

    // Check POI / amenity / shop / craft / office properties
    if (p.amenity || p.shop || p.office || p.craft || p.tourism || p.historic || p.leisure || p.man_made || p.healthcare || p.emergency || p.public) {
      return true;
    }

    return false;
  };

  // Sort geoData features so non-clickable background AREAs render at the bottom, and buildings/POIs render ON TOP
  const sortedGeoData = useMemo(() => {
    if (!geoData || !geoData.features) return null;

    const sortedFeatures = [...geoData.features].sort((a, b) => {
      const aVal = isClickableStructureOrPOI(a) ? 2 : (a.geometry?.type === 'LineString' ? 1 : 0);
      const bVal = isClickableStructureOrPOI(b) ? 2 : (b.geometry?.type === 'LineString' ? 1 : 0);
      return aVal - bVal;
    });

    return {
      ...geoData,
      features: sortedFeatures
    };
  }, [geoData]);

  const onEachFeature = (feature: any, layer: any) => {
    if (feature.properties) {
      if (isClickableStructureOrPOI(feature)) {
        layer.on('mouseover', () => {
          if (layer.getElement) {
            const el = layer.getElement();
            if (el) el.style.cursor = 'pointer';
          }
        });

        // Add click handler for HQ selection & Inspection
        layer.on('click', (e: any) => {
          L.DomEvent.stopPropagation(e);

          const details = getBuildingDetails(feature);
          if (e.latlng) {
            details.lat = e.latlng.lat;
            details.lon = e.latlng.lng;
          } else if (layer.getBounds) {
            const center = layer.getBounds().getCenter();
            details.lat = center.lat;
            details.lon = center.lng;
          }
          const fId = feature.id || feature.properties?.id || details.id;
          const bldgPop = cityPopulationState?.buildingPopulations[fId] || cityPopulationState?.buildingPopulations[details.id];

          if (gameSetupMode === 'choosing_hq') {
            const check = checkBuildingHQEligibility(feature);
            if (!check.isEligible) {
              setHqErrorReason(check.reason || "Ce bâtiment n'est pas éligible comme QG.");
              setCandidateHQ(null);
              // Open inspection modal even if ineligible as HQ so player can inspect farms/hangars/POIs
              setInspectedPoiData({ details, feature });
            } else {
              setHqErrorReason(null);

              let lat = 46.613, lon = 6.794;
              if (feature.geometry?.type === 'Point') {
                lat = feature.geometry.coordinates[1];
                lon = feature.geometry.coordinates[0];
              } else if (feature.geometry?.coordinates) {
                try {
                  const bounds = L.geoJSON(feature).getBounds();
                  const center = bounds.getCenter();
                  lat = center.lat;
                  lon = center.lng;
                } catch (err) {
                  console.warn("Could not compute feature bounds", err);
                }
              }

              setCandidateHQ({
                feature,
                featureId: fId,
                lat,
                lon,
                name: details.name || feature.properties?.name || 'Maison / Résidence',
                type: details.categoryLabel || check.buildingType || 'Habitation Résidentielle',
                area: details.groundAreaM2,
                capacity: details.maxHousingCapacity
              });

              // Automatically open detail inspection modal with full summary before validation
              setInspectedBuildingData({ details, bldgPop });
            }
          } else {
            // Open inspection modal for ANY clicked structure, farm, hangar, or POI
            const check = checkBuildingHQEligibility(feature);
            if (!check.isEligible) {
              setInspectedPoiData({ details, feature });
            } else {
              setInspectedBuildingData({ details, bldgPop });
            }
          }
        });
      }

      const fId = feature.id || feature.properties?.id || feature.properties?.['@id'] || (feature.properties?.osm_id ? `way/${feature.properties.osm_id}` : '') || `bldg-${feature.properties?.name ? feature.properties.name.replace(/\s+/g, '-').toLowerCase() : ''}`;

      let popupContent = '<div class="font-sans text-slate-900 p-1.5 space-y-2 min-w-[210px]">';
      if (feature.properties.name) {
        popupContent += `
          <div class="border-b border-slate-200 pb-1">
            <strong class="block text-sm font-bold text-slate-900">${feature.properties.name}</strong>
            <div class="text-[10px] text-slate-500 font-mono mt-0.5">ID BDD : <span class="text-cyan-700 font-bold">${fId}</span></div>
          </div>
        `;
      } else if (feature.properties.building) {
        popupContent += `
          <div class="border-b border-slate-200 pb-1">
            <strong class="block text-xs font-bold text-slate-800">Structure (${feature.properties.building})</strong>
            <div class="text-[10px] text-slate-500 font-mono mt-0.5">ID BDD : <span class="text-cyan-700 font-bold">${fId}</span></div>
          </div>
        `;
      } else if (fId) {
        popupContent += `
          <div class="border-b border-slate-200 pb-1">
            <div class="text-[10px] text-slate-500 font-mono">ID BDD : <span class="text-cyan-700 font-bold">${fId}</span></div>
          </div>
        `;
      }
      
      const props = ['amenity', 'shop', 'tourism', 'historic', 'leisure'];
      let isPOI = false;
      props.forEach(prop => {
        if (feature.properties[prop]) {
          isPOI = true;
          popupContent += `<div class="text-xs capitalize text-slate-600"><span class="font-semibold">${prop}:</span> ${feature.properties[prop]}</div>`;
        }
      });

      // Add Building Population Breakdown (Survivors & Indoor Zombies)
      const bldgPop = feature.properties?.building && cityPopulationState?.buildingPopulations[fId];

      if (bldgPop) {
        isPOI = true;
        popupContent += `
          <div class="bg-slate-50 border border-slate-200 rounded-lg p-2 space-y-1 text-xs mt-1">
            <div class="font-bold text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-200 pb-0.5">Occupation du Bâtiment</div>
            <div class="flex items-center justify-between font-semibold text-emerald-700 pt-0.5">
              <span>🟢 Vivants (retranchés) :</span>
              <strong class="font-mono text-sm">${bldgPop.survivors}</strong>
            </div>
            <div class="flex items-center justify-between font-semibold text-rose-700">
              <span>🔴 Infectés (tapis cachés) :</span>
              <strong class="font-mono text-sm">${bldgPop.indoorZombies}</strong>
            </div>
          </div>
        `;
      }

      popupContent += '</div>';
      
      if (isPOI || feature.properties.name || feature.properties.building) {
        // layer.bindPopup(popupContent);
      }

      if ((feature.properties.admin_level === '8' || feature.properties.admin_level === '9') && feature.properties.name && isZoomedOut) {
        layer.bindTooltip(feature.properties.name, {
          sticky: true,
          className: 'font-sans font-medium text-sm'
        });
      }
    }
  };

  if (!activeSessionId) {
    return (
      <>
        <QuotaNoticeBanner />
        <GameLobby 
          maxSquadSlots={maxSquadSlots}
          currentUser={currentUser}
          userProfile={userProfile}
          isAdmin={isAdmin}
          onShowProfile={() => setShowUserProfileModal(true)}
          onShowAdmin={() => setShowAdminModal(true)}
          onJoinSession={(sessionId, targetSquadId) => {
            setActiveSessionId(sessionId);
            if (targetSquadId) {
              setActiveSquadId(targetSquadId);
              setGameSetupMode('in_game');
            } else {
              setGameSetupMode('wizard');
            }
          }}
        />
        {showAdminModal && (
          <AdminModal onClose={() => setShowAdminModal(false)} />
        )}
        {showUserProfileModal && (
          <UserProfileModal
            userProfile={userProfile}
            currentUser={currentUser}
            onClose={() => setShowUserProfileModal(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="h-screen w-full bg-[#020617] text-slate-200 font-sans flex flex-col overflow-hidden relative">
      <QuotaNoticeBanner />
      <div className="flex-1 flex overflow-hidden relative">
      
      {/* 1. SETUP WIZARD OVERLAY */}
      {gameSetupMode === 'wizard' && (
        <GameSetupWizard
          activeSession={activeSession}
          currentUser={currentUser}
          availableCities={allCities}
          existingPlayerSquads={mySquads}
          onCancel={mySquads.length > 0 ? () => setGameSetupMode('in_game') : undefined}
          onReturnToLobby={() => setActiveSessionId(null)}
          onOpenCitySelector={() => setShowCitySelectorModal(true)}
          onSelectStartingCity={(city) => {
            setSelectedCityId(city.id);
            setSelectedCityName(city.name);
          }}
          selectedCity={allCities.find(c => c.id === selectedCityId) || (selectedCityId ? { id: selectedCityId, name: selectedCityName || 'Ville', createdAt: Date.now() } : null)}
          onLaunchGame={handleLaunchGameFromWizard}
        />
      )}

      {/* City Selector Modal overlay */}
      {showCitySelectorModal && (
        <div className="fixed inset-0 z-[3000] bg-slate-950/90 backdrop-blur-md overflow-y-auto p-3 sm:p-6 flex justify-center items-start sm:items-center">
          <div className="bg-[#020617] border border-slate-800 rounded-3xl max-w-4xl w-full p-5 sm:p-7 relative space-y-4 shadow-2xl my-auto max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 shrink-0">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <MapPin className="w-5 h-5 text-cyan-400" />
                Générer ou Sélectionner une Ville
              </h2>
              <button 
                onClick={() => setShowCitySelectorModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar">
              <CitySelector onSelectCity={(id, name) => {
                setSelectedCityId(id);
                setSelectedCityName(name);
                setShowCitySelectorModal(false);
              }} />
            </div>
          </div>
        </div>
      )}

      {/* 2. INVALID HQ ERROR MODAL */}
      {hqErrorReason && (
        <div className="fixed inset-0 z-[3500] bg-slate-950/80 backdrop-blur-sm overflow-y-auto p-4 flex justify-center items-start sm:items-center">
          <div className="bg-[#020617] border border-rose-500/50 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 relative my-auto">
            <div className="flex items-start gap-3">
              <div className="p-3 bg-rose-500/20 border border-rose-500/40 rounded-xl text-rose-400 shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Choix du QG Refusé</h3>
                <p className="text-xs text-rose-300 font-medium">{hqErrorReason}</p>
              </div>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed bg-slate-900/60 p-3 rounded-xl border border-slate-800">
              Rappel : Le quartier général de votre groupe de 5 survivants doit obligatoirement être établi dans une <strong>maison ou bâtiment résidentiel</strong> situé dans votre ville de départ. Les fermes, dépendances agricoles, usines et magasins ne sont pas autorisés.
            </p>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setHqErrorReason(null)}
                className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-xl cursor-pointer"
              >
                Compris, choisir une maison
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Left Panel: Survival Game Sidebar / City Details */}
      {isPanelCollapsed ? (
        <div className="w-16 h-full border-r border-slate-800 bg-[#020617] flex flex-col items-center py-5 z-[1000] relative shrink-0 justify-between shadow-2xl transition-all duration-300">
          <div className="flex flex-col items-center gap-5">
            <button 
              onClick={() => setIsPanelCollapsed(false)}
              className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:border-cyan-500/50 hover:bg-slate-800 transition-all shadow-md group cursor-pointer"
              title="Ouvrir le panneau"
            >
              <ChevronRight className="w-5 h-5 text-cyan-400 group-hover:translate-x-0.5 transition-transform" />
            </button>

            <div className="w-9 h-9 rounded-xl bg-rose-950/60 border border-rose-800/60 flex items-center justify-center text-rose-400 shadow-[0_0_12px_rgba(244,63,94,0.15)]" title={selectedCityName || "Survie"}>
              <Biohazard className="w-5 h-5" />
            </div>

            <div className="w-8 h-[1px] bg-slate-800" />

            <button
              onClick={() => setGameSetupMode('wizard')}
              className="p-2.5 rounded-xl bg-slate-900/60 hover:bg-slate-800 border border-slate-800/80 text-slate-400 hover:text-rose-400 transition-all cursor-pointer"
              title="Configuration Partie"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            <button
              onClick={() => setShowLegendModal(true)}
              className="p-2.5 rounded-xl bg-slate-900/60 hover:bg-slate-800 border border-slate-800/80 text-slate-400 hover:text-cyan-400 transition-all cursor-pointer"
              title="Légende de la carte"
            >
              <Layers className="w-4 h-4" />
            </button>

            {isAdmin && (
              <button
                onClick={() => setShowAdminModal(true)}
                className="px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 hover:text-rose-300 transition-all cursor-pointer mr-2 flex items-center gap-2 font-bold text-xs"
                title="Zone Admin"
              >
                <ShieldAlert className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => setShowUserProfileModal(true)}
              className="p-2 rounded-xl bg-slate-900/60 hover:bg-slate-800 border border-slate-800/80 text-cyan-400 hover:text-white transition-all cursor-pointer"
              title="Mon Profil Joueur"
            >
              <img
                src={userProfile?.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${currentUser?.uid}`}
                alt="Avatar"
                className="w-5 h-5 rounded-full object-cover"
              />
            </button>
          </div>

          <button 
            onClick={handleLogout} 
            className="p-2.5 rounded-xl bg-slate-900/40 hover:bg-slate-800 text-slate-500 hover:text-rose-400 transition-colors cursor-pointer" 
            title="Se déconnecter"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="w-80 sm:w-96 h-full border-r border-slate-800 bg-[#020617]/90 backdrop-blur-md flex flex-col z-[1000] relative shrink-0 transition-all duration-300">
          
          {/* Header */}
          <div className="p-4 pb-3 border-b border-slate-800/60 flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse shadow-[0_0_8px_#f43f5e]"></div>
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-rose-400">Post-Apocalypse & Survie</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-white capitalize">{selectedCityName || 'Ville inconnue'}</h1>
              <p className="text-slate-400 text-xs font-normal mt-0.5">
                {[cityDetails?.region || 'France/Suisse', cityDetails?.country].filter(Boolean).join(', ')}
              </p>
            </div>
            <button
              onClick={() => setIsPanelCollapsed(true)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition-colors border border-transparent hover:border-slate-700/60 cursor-pointer"
              title="Réduire le panneau"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          </div>

          {/* Body Content */}
          <div className="flex-1 px-6 py-4 space-y-5 overflow-y-auto custom-scrollbar">
            
            {/* Game Time & Real-Time Sync Indicator */}
            {(gameSetupMode === 'in_game' || gameSetupMode === 'choosing_hq') && (
              <div className="bg-slate-900/80 border border-slate-800 p-3 rounded-2xl flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]"></span>
                    Horloge Temps Réel Continu
                  </span>
                  <span className="text-sm font-mono font-bold text-cyan-400">{formatGameTime(gameTimeMinutes)}</span>
                </div>
                <div className="flex items-center gap-1.5 bg-emerald-950/60 border border-emerald-500/30 px-3 py-1.5 rounded-xl text-emerald-300 text-[10px] font-mono font-semibold">
                  <Clock className="w-3.5 h-3.5 text-emerald-400 animate-spin" style={{ animationDuration: '10s' }} />
                  <span>1 min / 10s réelles</span>
                </div>
              </div>
            )}

            {/* Session Info Box */}
            <div className="bg-gradient-to-br from-rose-950/40 via-slate-900/80 to-slate-900/40 border border-rose-500/30 p-4 rounded-2xl space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider">
                  <Biohazard className="w-4 h-4 text-rose-400" />
                  {selectedScenario}
                </div>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${selectedDifficulty.badgeColor}`}>
                  {selectedDifficulty.label}
                </span>
              </div>

              <div className="space-y-1 text-xs text-slate-300">
                <div className="flex justify-between text-[11px] font-mono">
                  <span>Infestés : <strong className="text-rose-400">{selectedDifficulty.infected}%</strong></span>
                  <span>Vivants : <strong className="text-emerald-400">{selectedDifficulty.survivors}%</strong></span>
                </div>
                <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden flex">
                  <div className="bg-rose-500 h-full" style={{ width: `${selectedDifficulty.infected}%` }}></div>
                  <div className="bg-emerald-400 h-full" style={{ width: `${selectedDifficulty.survivors}%` }}></div>
                </div>
              </div>

              <div className="pt-1">
                <button 
                  onClick={() => setActiveSessionId(null)}
                  className="w-full text-xs font-medium text-cyan-300 border border-cyan-800/60 bg-cyan-950/30 hover:bg-cyan-900/50 rounded-xl py-2.5 transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-sm"
                  title="Retourner au Lobby pour choisir une autre partie"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Changer de Partie / Scénario</span>
                </button>
              </div>
            </div>

            {/* City Goal & Fortification Panel */}
            {cityPopulationState && (
              <CityGoalPanel 
                cityName={selectedCityName || 'Commune'}
                cityPopulationState={cityPopulationState}
                difficulty={selectedDifficulty}
                userCharacters={userCharacters}
                gameTimeMinutes={gameTimeMinutes}
                onFortifyCity={handleFortifyCityWithPNJ}
              />
            )}

            {/* Population Breakdown Box */}
            {cityPopulationState && (
              <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-2xl space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-rose-400 flex items-center gap-1.5">
                    <Skull className="w-4 h-4 text-rose-500 animate-pulse" />
                    Population & Infestation
                  </h3>
                  <span className="text-[10px] font-mono text-slate-400">
                    Base : {cityPopulationState.basePopulation} hab.
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  {/* Survivors */}
                  <div className="bg-emerald-950/30 border border-emerald-500/30 p-2.5 rounded-xl space-y-1">
                    <div className="text-emerald-400 text-[10px] uppercase font-bold flex items-center gap-1">
                      🟢 Vivants ({100 - selectedDifficulty.infected}%)
                    </div>
                    <div className="text-base font-bold text-white font-mono">
                      {cityPopulationState.totalSurvivors} <span className="text-[10px] text-slate-400 font-normal">hab.</span>
                    </div>
                    <div className="text-[10px] text-emerald-300/80 leading-tight space-y-0.5 pt-0.5 border-t border-emerald-500/20">
                      <div>• <strong>{cityPopulationState.playerSurvivors}</strong> dans votre escouade</div>
                      <div>• <strong>{cityPopulationState.buildingSurvivors}</strong> dans les bâtiments</div>
                    </div>
                  </div>

                  {/* Total Infected */}
                  <div className="bg-rose-950/30 border border-rose-500/30 p-2.5 rounded-xl space-y-1">
                    <div className="text-rose-400 text-[10px] uppercase font-bold flex items-center gap-1">
                      🔴 Infectés ({selectedDifficulty.infected}%)
                    </div>
                    <div className="text-base font-bold text-white font-mono">
                      {cityPopulationState.totalInfected} <span className="text-[10px] text-slate-400 font-normal">zombies</span>
                    </div>
                    <div className="text-[10px] text-rose-300/80 leading-tight space-y-0.5 pt-0.5 border-t border-rose-500/20">
                      <div>• <strong>{cityPopulationState.indoorInfected}</strong> dans les bâtiments</div>
                      <div>• <strong>{cityPopulationState.outdoorInfected}</strong> dans la ville</div>
                    </div>
                  </div>
                </div>

                {/* Detail on Infected split & Global Casualties */}
                <div className="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80 text-[11px] space-y-1.5 text-slate-300 font-sans">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">🚪 Cachés dans les structures :</span>
                    <strong className="text-amber-400 font-mono">{cityPopulationState.indoorInfected} zombies</strong>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">☣️ Hordes errant en ville :</span>
                    <strong className="text-rose-400 font-mono">{cityPopulationState.outdoorInfected} zombies ({cityPopulationState.outdoorHordes?.length || 0} meutes)</strong>
                  </div>
                  <div className="pt-1 border-t border-slate-800/80 flex justify-between items-center text-[10px]">
                    <span className="text-rose-300">💀 Vivants tués / infectés :</span>
                    <strong className="text-rose-400 font-mono">{cityPopulationState.survivorsKilledOrInfected || 0} victimes</strong>
                  </div>
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="text-emerald-300">🪓 Infectés éliminés :</span>
                    <strong className="text-emerald-400 font-mono">{cityPopulationState.zombiesKilled || 0} éliminés</strong>
                  </div>
                </div>

                <p className="text-[10px] text-slate-400 italic leading-snug">
                  * Vos {cityPopulationState.playerSurvivors} personnages sont prélevés sur les {cityPopulationState.totalSurvivors} vivants de la ville (il reste {cityPopulationState.buildingSurvivors} vivants retranchés dans les bâtiments).
                </p>
              </div>
            )}

            {/* OSM Surface-based Resource Gauges */}
            {geoData && (
              <CityResourceGauges 
                geoData={geoData} 
                population={cityDetails?.population || null} 
                areaKm2={cityDetails?.areaKm2 || null} 
                cityName={selectedCityName || 'Commune'} 
              />
            )}
            {/* All Session Squads */}
            <div className="space-y-3 pt-2 border-t border-slate-800">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-emerald-400 flex items-center gap-1.5">
                <Users2 className="w-3.5 h-3.5" /> Équipes dans le Scénario ({sessionSquads.length})
              </h3>

              <div className="space-y-2">
                {sessionSquads.map(sq => {
                  const isMySquad = sq.uid === currentUser?.uid;
                  const isActive = activeSquad?.squadId === sq.squadId;

                  return (
                    <div 
                      key={sq.squadId} 
                      onClick={() => {
                        if (isMySquad) {
                          setActiveSquadId(sq.squadId);
                          if (sq.cityId) {
                            setSelectedCityId(sq.cityId);
                            setSelectedCityName(sq.cityName);
                          }
                        }
                      }}
                      className={`p-3 rounded-xl border text-xs space-y-1 transition-all ${
                        isActive
                          ? 'bg-rose-950/30 border-rose-500/60 ring-1 ring-rose-500/40'
                          : isMySquad 
                            ? 'bg-emerald-950/20 border-emerald-500/30 hover:border-emerald-500/60 cursor-pointer' 
                            : 'bg-slate-900/60 border-slate-800'
                      }`}
                    >
                      <div className="flex items-center justify-between font-bold text-white">
                        <span className="flex items-center gap-1.5">
                          <div className={`w-2 h-2 rounded-full ${isMySquad ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-cyan-400'}`}></div>
                          {sq.squadName || 'Équipe'} {isMySquad && '(Vous)'}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400">{sq.cityName}</span>
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center justify-between">
                        <span>QG: {sq.hqName || 'En attente...'}</span>
                        <span className="text-emerald-400 font-mono">{Array.isArray(sq.characters) ? sq.characters.length : 5} Survivants</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* City Demographics */}
            {cityDetails && (() => {
              const calculatedArea = cityDetails.areaKm2 || calculateGeoJSONAreaKm2(geoData);
              const calculatedDensity = cityDetails.density || (cityDetails.population && calculatedArea ? Math.round((cityDetails.population / calculatedArea) * 10) / 10 : null);

              return (
                <div className="space-y-3 pt-2 border-t border-slate-800">
                  <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Statistiques de la Ville</h3>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-slate-900/60 border border-slate-800 p-2.5 rounded-xl">
                      <div className="text-slate-400 text-[9px] uppercase font-bold">Population</div>
                      <div className="text-sm font-semibold text-white mt-0.5">
                        {cityDetails.population ? cityDetails.population.toLocaleString('fr-FR') : 'N/A'}
                      </div>
                    </div>

                    <div className="bg-slate-900/60 border border-slate-800 p-2.5 rounded-xl">
                      <div className="text-slate-400 text-[9px] uppercase font-bold">Superficie</div>
                      <div className="text-sm font-semibold text-white mt-0.5">
                        {calculatedArea !== null && calculatedArea !== undefined ? `${calculatedArea} km²` : 'N/A'}
                      </div>
                    </div>
                  </div>

                  {/* Weather */}
                  <div className="bg-slate-900/60 border border-slate-800 p-3 rounded-xl space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] font-bold uppercase text-slate-400">
                      <span>Météo locale</span>
                      {weather && <span className="text-sky-300">{weather.weatherDescription}</span>}
                    </div>
                    {weatherLoading ? (
                      <div className="text-xs text-slate-500">Météo en cours...</div>
                    ) : weather ? (
                      <div className="flex items-center justify-between text-xs text-slate-200">
                        <span className="text-lg font-light">{weather.temperature}°C</span>
                        <div className="flex items-center gap-3 text-[11px] text-slate-400">
                          <span><Wind className="w-3 h-3 inline mr-1" />{weather.windSpeed} km/h</span>
                          <span><Droplets className="w-3 h-3 inline mr-1" />{weather.humidity}%</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">Données météo indisponibles</div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Legend Modal Trigger Button */}
            <div className="pt-2">
              <button
                onClick={() => setShowLegendModal(true)}
                className="w-full text-xs font-medium text-cyan-300 border border-cyan-800/60 bg-cyan-950/40 hover:bg-cyan-900/60 rounded-xl py-2.5 px-3 flex items-center justify-center gap-2 transition-colors shadow-sm cursor-pointer"
              >
                <Layers className="w-4 h-4 text-cyan-400" />
                Légende de la Carte
              </button>
            </div>
          </div>

          {/* Metadata Footer */}
          <div className="p-4 px-6 text-[9px] font-mono text-slate-500 border-t border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              {isAdmin && (
                <button onClick={() => setShowAdminModal(true)} className="flex items-center gap-1.5 px-2 py-1 mr-2 bg-rose-500/10 rounded border border-rose-500/20 text-rose-500 hover:text-rose-400 cursor-pointer transition-colors font-bold uppercase tracking-wider" title="Zone Admin">
                  <ShieldAlert className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={() => setShowUserProfileModal(true)}
                className="flex items-center gap-2 hover:text-white transition-colors cursor-pointer text-left group"
              >
                <img
                  src={userProfile?.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${currentUser?.uid}`}
                  alt="Avatar"
                  className="w-5 h-5 rounded-full object-cover border border-cyan-500/60"
                />
                <span className="text-xs font-bold text-slate-300 group-hover:text-cyan-400">
                  {userProfile?.displayName || currentUser?.email?.split('@')[0]}
                </span>
              </button>

              <button onClick={handleLogout} className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer transition-colors" title="Se déconnecter">
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
            
          </div>
        </div>
      )}

      {/* Legend Modal */}
      {showLegendModal && (
        <div className="fixed inset-0 z-[3000] bg-slate-950/80 backdrop-blur-sm overflow-y-auto p-4 flex justify-center items-start sm:items-center">
          <div className="bg-[#020617] border border-slate-800 rounded-2xl p-6 max-w-sm w-full shadow-2xl relative space-y-4 my-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-cyan-400" />
                <h3 className="text-sm font-bold uppercase tracking-wider text-white">Légende de la Carte</h3>
              </div>
              <button 
                onClick={() => setShowLegendModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3.5 pt-1">
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 border border-emerald-400 bg-emerald-500/40 rounded-sm shrink-0"></div>
                <span className="text-xs text-slate-200">QG de Survivants (Valide)</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 border border-cyan-400/50 bg-cyan-400/10 rounded-sm shrink-0"></div>
                <span className="text-xs text-slate-200">Bâtiments / Structures (Vivants & Infectés cachés)</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 rounded-full bg-rose-950 border border-rose-500 shadow-[0_0_8px_#f43f5e] flex items-center justify-center text-[9px] font-bold text-rose-300 shrink-0">
                  ☣️
                </div>
                <span className="text-xs text-slate-200">Hordes d'Infestés visibles en ville (Effet rouge)</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-4 h-[2px] bg-white shadow-[0_0_8px_white] shrink-0"></div>
                <span className="text-xs text-slate-200">Limites Communales</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full border border-rose-600/70 bg-rose-500/40 shrink-0"></div>
                <span className="text-xs text-slate-200">Points d'Intérêt</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Right Panel: Interactive Map View */}
      <div className="flex-1 h-full relative bg-[#0b0f1a] overflow-hidden">
        
        {/* Street Explorer Bar */}
        {selectedCityId && selectedCityName && (
          <div className={`absolute ${gameSetupMode === 'choosing_hq' ? 'top-24' : 'top-4'} left-1/2 -translate-x-1/2 z-[2000] w-[92%] max-w-lg pointer-events-auto transition-all`}>
            <StreetExplorerBar
              cityId={selectedCityId}
              cityName={selectedCityName}
              cityLat={cityDetails?.lat}
              cityLon={cityDetails?.lon}
              onNavigateToCoords={(lat, lon, zoom = 17) => {
                setMapCenter([lat, lon]);
              }}
            />
          </div>
        )}

        {/* Banner Instruction when choosing HQ */}
        {gameSetupMode === 'choosing_hq' && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[2000] bg-slate-950/90 border border-emerald-500/60 shadow-2xl rounded-2xl px-5 py-2.5 max-w-xl w-[90%] backdrop-blur-md space-y-1 text-center pointer-events-auto">
            <div className="flex items-center justify-center gap-2 text-emerald-400 font-bold text-xs uppercase tracking-wider">
              <Crosshair className="w-4 h-4 animate-spin" />
              Étape Finale : Fixez votre QG sur la carte
            </div>
            <p className="text-xs text-slate-200">
              Sélectionnez une rue ci-dessous ou cliquez sur un bâtiment de la zone pour fixer votre QG à {selectedCityName}.
            </p>
          </div>
        )}

        {/* Exploring Location Status Badge */}
        {exploringStatusMessage && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[2000] bg-slate-950/95 border border-cyan-500/80 shadow-2xl rounded-2xl px-4 py-2 text-xs font-semibold text-cyan-300 backdrop-blur-md flex items-center gap-2 pointer-events-none animate-bounce">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <span>{exploringStatusMessage}</span>
          </div>
        )}

        

        {(loading || cityStatus === 'loading' || cityStatus === 'generating') && (
          <div className="absolute inset-0 z-[2000] bg-[#0b0f1a]/95 flex flex-col items-center justify-center backdrop-blur-md pointer-events-auto">
            <div className="relative mb-6">
              <div className="absolute inset-0 bg-cyan-500 blur-xl opacity-30 rounded-full animate-pulse"></div>
              <Loader2 className="w-16 h-16 text-cyan-400 animate-spin relative z-10" />
            </div>
            <h2 className="text-2xl font-black text-white tracking-tight mb-2">
              {cityStatus === 'generating' ? 'Génération de la ville' : 'Connexion au satellite'}
            </h2>
            <p className="text-cyan-400/80 font-mono text-sm tracking-widest uppercase">
              {cityStatus === 'generating' ? 'Analyse de la population & infectés en cours...' : 'Chargement des données cartographiques...'}
            </p>
          </div>
        )}
        
        {error && (
          <div className="absolute inset-0 z-[2000] bg-[#0b0f1a]/90 flex flex-col items-center justify-center p-6 text-center">
            <div className="p-4 border border-red-500/30 bg-red-500/10 text-red-400 rounded-lg max-w-md font-mono">
              <h2 className="font-bold mb-2">CRITICAL ERROR</h2>
              <p>{error}</p>
              <button 
                onClick={() => setSelectedCityId(null)}
                className="mt-4 px-4 py-2 bg-slate-800 text-white rounded hover:bg-slate-700 cursor-pointer"
              >
                Retour
              </button>
            </div>
          </div>
        )}

        <MapContainer 
          center={[46.613, 6.794]}
          zoom={15} 
          minZoom={4}
          maxBounds={[[-90, -180], [90, 180]]}
          maxBoundsViscosity={1.0}
          className="h-full w-full z-0"
          zoomControl={false}
          attributionControl={false}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            noWrap={true}
          />
          <ZoomTracker onZoomChange={setZoomLevel} />
          <MapClickHandler selectedCityId={selectedCityId} selectedCityName={selectedCityName} onExploreLocation={handleExploreLocation} />
          <MapResizeHandler isPanelCollapsed={isPanelCollapsed}
                characterToLocate={characterToLocate} />
          <MapCenterer center={mapCenter} onCentered={() => setMapCenter(null)} />
          
          
          {allCities.filter(c => c.id !== selectedCityId && c.boundary).map(city => {
            let boundaryData;
            try {
              boundaryData = JSON.parse(city.boundary);
            } catch (e) {
              return null;
            }
            if (!boundaryData || Object.keys(boundaryData).length === 0 || isInvalidOrDistrictBoundary(boundaryData, city.areaKm2)) return null;
            
            return (
              <GeoJSON 
                key={`other-city-${city.id}`} 
                data={boundaryData} 
                style={{
                  color: '#334155',
                  weight: 2,
                  opacity: 0.8,
                  fillColor: 'transparent',
                  dashArray: '4, 4'
                }}
              >
                <Tooltip direction="center" permanent className="city-tooltip" opacity={0.6}>
                  {city.name}
                </Tooltip>
              </GeoJSON>
            );
          })}

          {/* Render Outdoor Zombie Horde Markers */}
          {gameSetupMode !== 'choosing_hq' && cityPopulationState?.outdoorHordes.map(horde => {
            if (!isPointVisible(horde.lat, horde.lon)) return null;
            // Simulate slow movement: orbit around their initial point based on time
            // Use their ID string to give them slightly different speeds/phases
            const seed = parseInt(horde.id.replace(/\D/g, '')) || 0;
            const phase = seed % 100;
            const speed = 0.0001 + (seed % 5) * 0.00005; // Different orbital radius
            
            // gameTimeMinutes provides the progression. 
            const moveOffsetLat = Math.sin((gameTimeMinutes + phase) * 0.1) * speed;
            const moveOffsetLon = Math.cos((gameTimeMinutes + phase) * 0.1) * speed;
            const currentLat = horde.lat + moveOffsetLat;
            const currentLon = horde.lon + moveOffsetLon;

            const hordeIcon = L.divIcon({
              className: 'custom-zombie-horde-marker',
              html: isZoomedOut ? `
                <div class="relative flex items-center justify-center cursor-pointer">
                  <div class="w-2.5 h-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)] border border-rose-900 z-10"></div>
                  <div class="absolute ml-8 px-1.5 py-0.5 rounded bg-slate-900/80 border border-slate-700/50 text-[9px] font-bold text-rose-400 whitespace-nowrap shadow-sm">
                    ${horde.count}
                  </div>
                </div>
              ` : `
                <div class="relative flex flex-col items-center group cursor-pointer transition-all duration-1000 ease-linear">
                  <!-- Pulsing Red Outer Glow -->
                  <div class="absolute -inset-2 rounded-full bg-rose-500/30 animate-ping"></div>
                  <!-- Main Zombie Badge -->
                  <div class="relative w-9 h-9 rounded-full bg-rose-950 border-2 border-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.9)] flex items-center justify-center text-rose-400 font-bold z-10">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-pulse"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/><circle cx="12" cy="12" r="3"/><path d="m12 15 2 2"/><path d="m12 9-2-2"/></svg>
                  </div>
                  <!-- Zombie Count Badge -->
                  <div class="z-20 -mt-1 px-2 py-0.5 rounded-full bg-rose-950/95 border border-rose-500 text-[10px] font-black text-rose-300 font-mono shadow-xl whitespace-nowrap">
                    ☣️ ${horde.count} zombies
                  </div>
                </div>
              `,
              iconSize: isZoomedOut ? [12, 12] : [36, 48],
              iconAnchor: isZoomedOut ? [6, 6] : [18, 24]
            });

            return (
              <Marker 
                key={`horde-${horde.id}`} 
                position={[currentLat, currentLon]} 
                icon={hordeIcon}
                eventHandlers={{
                  click: () => setSelectedHordeForCombat(horde)
                }}
              >
                <Popup className="custom-popup">
                  <div className="p-2 space-y-2 text-xs min-w-[210px]">
                    <div className="font-bold text-slate-900 border-b pb-1 flex justify-between items-center">
                      <span className="flex items-center gap-1.5 text-rose-700 font-mono">
                        ☣️ Horde d'Infestés
                      </span>
                      <span className="text-[10px] text-rose-700 bg-rose-100 border border-rose-300 px-1.5 py-0.5 rounded font-mono font-bold">
                        {horde.threatLevel}
                      </span>
                    </div>
                    <div className="text-slate-800">
                      Groupe de <strong>{horde.count} zombies</strong> rôdant à découvert dans les rues ({horde.streetName || 'Secteur urbain'}).
                    </div>
                    <div className="bg-rose-50 border border-rose-200 rounded p-1.5 text-[11px] text-rose-900 leading-tight">
                      ⚠️ <strong>Menace active :</strong> Ces zombies errent en extérieur et attaquent à vue tout survivant imprudent.
                    </div>
                    <button
                      onClick={() => setSelectedHordeForCombat(horde)}
                      className="w-full mt-1.5 py-2 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow"
                    >
                      <Swords className="w-3.5 h-3.5" />
                      <span>Attaquer la Horde (Combat)</span>
                    </button>
                  </div>
                </Popup>
              </Marker>
            );
          })}
          {sessionSquads.map(sq => {
            if (!sq.hqLat || !sq.hqLon) return null;
            const isMe = sq.uid === currentUser?.uid;
            const isSelectedActiveSquad = sq.squadId === activeSquad?.squadId;
            let squadChars: SurvivorCharacter[] = [];
            if (isMe) {
              squadChars = userCharacters;
            } else if (sq.characters) {
              try {
                const parsed = typeof sq.characters === 'string' ? JSON.parse(sq.characters) : sq.characters;
                squadChars = Array.isArray(parsed) ? parsed : [];
              } catch (e) {
                // ignore
              }
            }

            const hqFortification = sq.customBuildings?.[sq.hqFeatureId]?.fortificationLevel ?? 80; // Sync with actual HQ data

            // Determine which characters are currently travelling
            const travelingCharacterIds = (sq.activeTravels || []).flatMap((t: ActiveTravel) => t.characterIds);

            // Categorize characters by location
            const hqChars: { char: SurvivorCharacter; idx: number; charNum: number; color: any }[] = [];
            const buildingGroups: Record<string, { buildingName?: string; lat: number; lon: number; characters: { char: SurvivorCharacter; idx: number; charNum: number; color: any }[] }> = {};
            const streetChars: { char: SurvivorCharacter; idx: number; charNum: number; color: any; lat: number; lon: number; buildingName?: string }[] = [];

            squadChars.forEach((c, idx) => {
              if (travelingCharacterIds.includes(c.id)) return; // Do not render inside buildings if currently travelling

              const charNum = idx + 1;
              const color = getCharacterColor(idx);
              const locType = c.locationType || 'hq';

              if (locType === 'hq' || !locType || (locType === 'building' && c.buildingId === sq.hqFeatureId)) {
                hqChars.push({ char: c, idx, charNum, color });
              } else if (locType === 'building' && c.buildingId) {
                if (!buildingGroups[c.buildingId]) {
                  buildingGroups[c.buildingId] = {
                    buildingName: c.buildingName || 'Structure',
                    lat: c.lat || sq.hqLat!,
                    lon: c.lon || sq.hqLon!,
                    characters: []
                  };
                }
                buildingGroups[c.buildingId].characters.push({ char: c, idx, charNum, color });
              } else if (locType === 'street' || (locType as string) === 'exterior') {
                streetChars.push({
                  char: c,
                  idx,
                  charNum,
                  color,
                  lat: c.lat || sq.hqLat!,
                  lon: c.lon || sq.hqLon!,
                  buildingName: c.buildingName
                });
              }
            });

            const hqCharsHtml = hqChars.map(item => `
              <span title="${item.char.name} (${item.char.role})" style="background-color: ${item.color.hex};" class="w-4 h-4 rounded-full border border-white flex items-center justify-center text-[9px] font-extrabold text-white shadow shrink-0">
                ${item.charNum}
              </span>
            `).join('');

            const customIcon = L.divIcon({
              className: 'custom-hq-marker',
              html: `
                <div class="relative flex flex-col items-center group cursor-pointer">
                  <div class="w-7 h-7 rounded-full ${
                    isSelectedActiveSquad 
                      ? 'bg-emerald-500 border-2 border-white shadow-[0_0_20px_#10b981]' 
                      : isMe 
                      ? 'bg-emerald-600 border-2 border-emerald-300 shadow-[0_0_15px_#10b981]' 
                      : 'bg-cyan-600 border-2 border-cyan-200 shadow-[0_0_15px_#06b6d4]'
                  } flex items-center justify-center text-white font-bold">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                  </div>
                  <div class="absolute top-full mt-1 flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
                    <div class="px-2.5 py-0.5 rounded-full bg-slate-900/90 border border-slate-700 text-[10px] font-bold text-white whitespace-nowrap shadow-xl flex items-center gap-1.5">
                      <span>${isMe ? `QG ${sq.squadName || 'Équipe 1'}` : `QG (${sq.email?.split('@')[0] || 'Joueur'})`}</span>
                      ${hqChars.length > 0 ? `<div class="flex items-center gap-1 border-l border-slate-700/80 pl-1.5">${hqCharsHtml}</div>` : ''}
                    </div>
                    <!-- Fortification Badge -->
                    <div class="px-2 py-0.5 rounded-full bg-emerald-950/90 border border-emerald-500/60 text-[9px] font-bold text-emerald-300 font-mono shadow-md whitespace-nowrap flex items-center gap-1">
                      🛡️ Fortification : ${hqFortification}%
                    </div>
                  </div>
                </div>
              `,
              iconSize: [28, 28],
              iconAnchor: [14, 14]
            });

            return (
              <React.Fragment key={`squad-group-${sq.squadId}`}>
                {/* 0. Squad Travel Routes / Paths on Map */}
                {(sq.travelRoutes || []).map((rt: TravelRoute, rtIdx: number) => {
                  if (!rt.fromLat || !rt.fromLon || !rt.toLat || !rt.toLon) return null;
                  const midLat = (rt.fromLat + rt.toLat) / 2;
                  const midLon = (rt.fromLon + rt.toLon) / 2;
                  const mainColor = isMe ? '#06b6d4' : '#a855f7';
                  const brightColor = isMe ? '#22d3ee' : '#e9d5ff';

                  const routeBadgeIcon = L.divIcon({
                    className: 'custom-route-badge-marker',
                    html: `
                      <div class="relative flex flex-col items-center group cursor-pointer pointer-events-auto">
                        <div class="px-2.5 py-1 rounded-full bg-slate-950/95 border border-cyan-400/80 text-[10px] font-bold text-cyan-300 font-mono shadow-[0_0_15px_rgba(6,182,212,0.4)] whitespace-nowrap flex items-center gap-1.5">
                          <span class="animate-pulse text-xs">${rt.vehicleName ? '🚗' : '🏃'}</span>
                          <span class="text-white">${rt.characterNames.join(', ')}</span>
                          <span class="text-cyan-400/80 text-[9px] font-semibold">(${rt.fromName} ➔ ${rt.toName})</span>
                        </div>
                      </div>
                    `,
                    iconSize: [160, 26],
                    iconAnchor: [80, 13]
                  });

                  return (
                    <React.Fragment key={`route-${sq.squadId}-${rt.id || rtIdx}`}>
                      {/* Outer Glow Polyline */}
                      <Polyline
                        positions={[[rt.fromLat, rt.fromLon], [rt.toLat, rt.toLon]]}
                        pathOptions={{
                          color: mainColor,
                          weight: 8,
                          opacity: 0.35,
                          lineCap: 'round'
                        }}
                      />
                      {/* Inner Dashed Tactical Vector */}
                      <Polyline
                        positions={[[rt.fromLat, rt.fromLon], [rt.toLat, rt.toLon]]}
                        pathOptions={{
                          color: brightColor,
                          weight: 3,
                          opacity: 0.95,
                          dashArray: '8, 12'
                        }}
                      />
                      {/* Route Midpoint Badge */}
                      <Marker
                        position={[midLat, midLon]}
                        icon={routeBadgeIcon}
                        interactive={false}
                      />
                    </React.Fragment>
                  );
                })}

                {/* 0.5. Active Real-Time Travels on Map */}
                {(sq.activeTravels || []).map((travel: ActiveTravel) => {
                  if (!travel.fromLat || !travel.fromLon || !travel.toLat || !travel.toLon) return null;

                  const elapsedMs = nowTick - travel.startTime;
                  const totalMs = travel.durationSeconds * 1000;
                  const progress = Math.min(1, Math.max(0, elapsedMs / totalMs));
                  const remainingSec = Math.max(0, Math.ceil(travel.durationSeconds - elapsedMs / 1000));

                  const currentLat = travel.fromLat + (travel.toLat - travel.fromLat) * progress;
                  const currentLon = travel.fromLon + (travel.toLon - travel.fromLon) * progress;

                  const travelIcon = L.divIcon({
                    className: 'custom-active-travel-marker',
                    html: `
                      <div class="relative flex flex-col items-center group cursor-pointer pointer-events-auto">
                        <div class="p-2 rounded-full bg-cyan-500 text-slate-950 shadow-[0_0_20px_rgba(6,182,212,0.9)] border-2 border-white animate-pulse">
                          <span class="text-base">${travel.vehicleName ? '🚗' : '🏃'}</span>
                        </div>
                        <div class="mt-1 px-2.5 py-1 rounded-full bg-slate-950/95 border border-cyan-400 text-[10px] font-bold text-cyan-300 font-mono shadow-xl whitespace-nowrap flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity absolute top-full z-50 pointer-events-none">
                          <span class="text-white">${travel.characterNames.join(', ')}</span>
                          <span class="text-amber-300">➔ ${travel.toName}</span>
                          <span class="text-cyan-400 font-bold bg-cyan-950 px-1.5 py-0.5 rounded border border-cyan-500/40">${remainingSec}s</span>
                        </div>
                      </div>
                    `,
                    iconSize: [180, 48],
                    iconAnchor: [90, 24]
                  });

                  return (
                    <React.Fragment key={`active-travel-${travel.id}`}>
                      <Polyline
                        positions={[[travel.fromLat, travel.fromLon], [travel.toLat, travel.toLon]]}
                        pathOptions={{ color: '#06b6d4', weight: 4, opacity: 0.7, dashArray: '6, 8' }}
                      />
                      <Marker position={[currentLat, currentLon]} icon={travelIcon} />
                    </React.Fragment>
                  );
                })}

                {/* 0.6. Active Real-Time Scavenges on Map */}
                {(sq.activeScavenges || []).map((scavenge: ActiveScavenge) => {
                  const bldgData = activeSquad?.customBuildings?.[scavenge.buildingId];
                  const lat = bldgData?.lat || sq.hqLat;
                  const lon = bldgData?.lon || sq.hqLon;
                  if (!lat || !lon) return null;

                  const elapsedMs = nowTick - scavenge.startTime;
                  const totalMs = scavenge.durationSeconds * 1000;
                  const progressPercent = Math.min(100, Math.round((elapsedMs / totalMs) * 100));
                  const remainingSec = Math.max(0, Math.ceil(scavenge.durationSeconds - elapsedMs / 1000));

                  const scavengeMapIcon = L.divIcon({
                    className: 'custom-active-scavenge-marker',
                    html: `
                      <div class="relative flex flex-col items-center pointer-events-auto">
                        <div class="p-2 rounded-full bg-amber-500 text-slate-950 shadow-[0_0_20px_rgba(245,158,11,0.9)] border-2 border-amber-200 animate-bounce">
                          <span class="text-base">🔍</span>
                        </div>
                        <div class="mt-1 px-2.5 py-1 rounded-xl bg-slate-950/95 border border-amber-400 text-[10px] font-bold text-amber-300 font-mono shadow-2xl whitespace-nowrap flex flex-col items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity absolute top-full z-50 pointer-events-none">
                          <div class="flex items-center gap-1.5">
                            <span>Fouille ${scavenge.buildingName}</span>
                            <span class="text-amber-400 bg-amber-950 px-1 rounded">${progressPercent}%</span>
                          </div>
                          <div class="text-[9px] text-slate-300">⏱️ ${remainingSec}s restantes (${Math.ceil(remainingSec / 10)} min)</div>
                        </div>
                      </div>
                    `,
                    iconSize: [180, 54],
                    iconAnchor: [90, 27]
                  });

                  return (
                    <Marker key={`active-scavenge-${scavenge.id}`} position={[lat, lon]} icon={scavengeMapIcon} />
                  );
                })}

                {/* 1. Squad HQ Marker */}
                <Marker 
                  key={`squad-hq-${sq.squadId}`} 
                  position={[sq.hqLat, sq.hqLon]} 
                  icon={customIcon}
                  eventHandlers={{
                    click: () => {
                      if (isMe && !isSelectedActiveSquad) {
                        setActiveSquadId(sq.squadId);
                        if (sq.cityId && sq.cityId !== selectedCityId) {
                          setSelectedCityId(sq.cityId);
                          setSelectedCityName(sq.cityName);
                        }
                      }

                      if (geoData && geoData.features) {
                        const hqFeature = geoData.features.find((f: any) => {
                          const d = getBuildingDetails(f);
                          return d.id === sq.hqFeatureId;
                        });
                        if (hqFeature) {
                          const details = getBuildingDetails(hqFeature);
                          const bldgPop = cityPopulationState?.buildingPopulations[details.id];
                          setInspectedBuildingData({ details, bldgPop });
                          return;
                        }
                      }
                      
                      if (sq.hqFeatureId) {
                        const mockDetails = {
                          id: sq.hqFeatureId,
                          name: sq.hqName || 'QG',
                          type: 'residential',
                          category: 'résidence',
                          groundAreaM2: 150,
                          levels: 1,
                          maxHousingCapacity: 5,
                          dangerLevel: 'safe',
                          color: '#10b981',
                          lat: sq.hqLat,
                          lon: sq.hqLon
                        };
                        setInspectedBuildingData({ details: mockDetails as any, bldgPop: undefined });
                      }
                    }
                  }}
                />

                {/* 2. Building Structure Search Markers for this Squad */}
                {Object.entries(buildingGroups).map(([bldgId, group]) => {
                  const bldgCharsHtml = group.characters.map(item => `
                    <span title="${item.char.name} (${item.char.role})" style="background-color: ${item.color.hex};" class="w-4 h-4 rounded-full border border-white flex items-center justify-center text-[9px] font-extrabold text-white shadow shrink-0">
                      ${item.charNum}
                    </span>
                  `).join('');

                  const bldgIcon = L.divIcon({
                    className: 'custom-bldg-search-marker',
                    html: `
                      <div class="relative flex flex-col items-center group cursor-pointer">
                        <div class="w-9 h-9 rounded-full bg-cyan-600 border-2 border-cyan-200 shadow-[0_0_18px_#06b6d4] flex items-center justify-center text-white font-bold animate-pulse">
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                        </div>
                        <div class="mt-1 px-2.5 py-0.5 rounded-full bg-slate-900/95 border border-cyan-500/60 text-[10px] font-bold text-white whitespace-nowrap shadow-xl flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity absolute top-full z-50 pointer-events-none">
                          <span class="text-cyan-300 font-bold">Fouille ${sq.squadName || 'Équipe 1'} :</span>
                          <div class="flex items-center gap-1">
                            ${bldgCharsHtml}
                          </div>
                        </div>
                        <div class="mt-0.5 px-2 py-0.5 rounded-full bg-cyan-950/90 border border-cyan-500/40 text-[9px] font-bold text-cyan-300 font-mono shadow-md whitespace-nowrap">
                          🔍 ${group.buildingName || 'Structure'}
                        </div>
                      </div>
                    `,
                    iconSize: [28, 28],
              iconAnchor: [14, 14]
                  });

                  return (
                    <Marker
                      key={`squad-bldg-${sq.squadId}-${bldgId}`}
                      position={[group.lat, group.lon]}
                      icon={bldgIcon}
                      eventHandlers={{
                        click: () => {
                          if (geoData && geoData.features) {
                            const bldgFeature = geoData.features.find((f: any) => {
                              const d = getBuildingDetails(f);
                              return d.id === bldgId;
                            });
                            if (bldgFeature) {
                              const details = getBuildingDetails(bldgFeature);
                              details.lat = group.lat;
                              details.lon = group.lon;
                              const bldgPop = cityPopulationState?.buildingPopulations[details.id];
                              setInspectedBuildingData({ details, bldgPop });
                              return;
                            }
                          }
                          const mockDetails = {
                            id: bldgId,
                            name: group.buildingName || 'Bâtiment en fouille',
                            type: 'building',
                            category: 'fouille',
                            groundAreaM2: 120,
                            levels: 1,
                            maxHousingCapacity: 4,
                            dangerLevel: 'moderate',
                            color: '#06b6d4',
                            lat: group.lat,
                            lon: group.lon
                          };
                          setInspectedBuildingData({ details: mockDetails as any, bldgPop: undefined });
                        }
                      }}
                    />
                  );
                })}

                {/* 3. Street / Town Character Markers for this Squad */}
                {streetChars.map(item => {
                  const streetIcon = L.divIcon({
                    className: 'custom-street-char-marker',
                    html: `
                      <div class="relative flex flex-col items-center group cursor-pointer">
                        <div style="background-color: ${item.color.hex}; box-shadow: 0 0 14px ${item.color.hex};" class="w-8 h-8 rounded-full border-2 border-white flex items-center justify-center text-white font-extrabold text-xs shadow-2xl">
                          ${item.charNum}
                        </div>
                        <div class="mt-1 px-2.5 py-0.5 rounded-full bg-slate-900/95 border border-slate-700 text-[10px] font-bold text-white whitespace-nowrap shadow-xl flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity absolute top-full z-50 pointer-events-none">
                          <span style="background-color: ${item.color.hex};" class="w-2 h-2 rounded-full"></span>
                          <span>${item.char.name}</span>
                          <span class="text-slate-400 text-[9px] font-normal">(${item.char.role})</span>
                        </div>
                      </div>
                    `,
                    iconSize: [36, 56],
                    iconAnchor: [18, 56]
                  });

                  return (
                    <Marker
                      key={`squad-street-${sq.squadId}-${item.char.id}`}
                      position={[item.lat, item.lon]}
                      icon={streetIcon}
                      eventHandlers={{
                        click: () => {
                          setInspectedCharacter(item.char);
                        }
                      }}
                    />
                  );
                })}
              </React.Fragment>
            );
          })}

          {sortedGeoData && (
            <>
              <GeoJSON 
                key={`geojson-${selectedCityId}-${isZoomedOut ? 'zoomed-out' : 'zoomed-in'}-${candidateHQ?.featureId || 'none'}-${sortedGeoData.features?.length || 0}`}
                data={sortedGeoData} 
                style={styleFeature} 
                pointToLayer={pointToLayer}
                onEachFeature={onEachFeature}
              />
              <MapViewController 
                data={sortedGeoData} 
                activeSquad={activeSquad} 
                selectedCityId={selectedCityId} 
                isPanelCollapsed={isPanelCollapsed} 
                characterToLocate={characterToLocate}
              />
            </>
          )}



          {/* Vision Circles on Map */}
          {gameSetupMode === 'in_game' && visionPoints.map((vp, idx) => (
            <Circle
              key={`vision-${idx}`}
              center={[vp.lat, vp.lon]}
              radius={vp.radius}
              pathOptions={{
                color: '#22d3ee',
                fillColor: '#06b6d4',
                fillOpacity: 0.05,
                weight: 1,
                dashArray: '4, 4',
                interactive: false
              }}
            />
          ))}

          {/* Acoustic Propagation / Gunshot Noise Waves on Map */}
          {activeNoiseEvents.map(event => (
            <div key={`noise-group-${event.id}`}>
              <Circle
                center={[event.lat, event.lon]}
                radius={event.radiusMeters}
                pathOptions={{
                  color: '#ef4444',
                  fillColor: '#f87171',
                  fillOpacity: 0.18,
                  weight: 2,
                  dashArray: '6, 8'
                }}
              >
                <Tooltip permanent direction="top">
                  <div className="text-[10px] font-mono font-bold text-rose-300 bg-slate-950/90 border border-rose-500/80 px-2 py-0.5 rounded shadow-xl flex items-center gap-1">
                    <span>🔊 {event.sourceName}</span>
                    <span className="text-amber-400">({event.decibels} dB • Rayon {event.radiusMeters}m)</span>
                  </div>
                </Tooltip>
              </Circle>
              <Circle
                center={[event.lat, event.lon]}
                radius={Math.max(15, event.radiusMeters * 0.35)}
                pathOptions={{
                  color: '#f59e0b',
                  fillColor: '#fbbf24',
                  fillOpacity: 0.3,
                  weight: 1.5
                }}
              />
            </div>
          ))}
          <FogOfWar visionPoints={visionPoints} isActive={gameSetupMode === 'in_game'} />
        </MapContainer>

        <div className="absolute bottom-0 left-0 right-0 z-[2000] bg-slate-950/80 backdrop-blur-md border-t border-slate-800 py-0.5 px-3 flex justify-between items-center text-[9px] sm:text-[10px] text-slate-500 font-mono pointer-events-none">
          <div className="flex gap-4">
            <span>ENGINE: SURVIVAL_V4.2</span>
            <span>FIRESTORE: CONNECTED</span>
          </div>
          <div className="text-slate-600">
            Leaflet | © OpenStreetMap contributors © CARTO
          </div>
        </div>

        <div className="absolute top-4 right-4 z-[1000] flex items-center gap-3">

          

          <div className="w-10 h-10 rounded-2xl border border-slate-800 bg-slate-950/80 backdrop-blur-md flex items-center justify-center shadow-lg">
            <div className="text-[10px] font-bold text-white relative">
              N
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[3px] border-l-transparent border-r-[3px] border-r-transparent border-b-[5px] border-b-cyan-400"></div>
            </div>
          </div>
        </div>

        {/* User Profile Modal */}
        {showAdminModal && (
          <AdminModal onClose={() => setShowAdminModal(false)} />
        )}
        
        {showUserProfileModal && (
          <UserProfileModal
            userProfile={userProfile}
            currentUser={currentUser}
            onClose={() => setShowUserProfileModal(false)}
          />
        )}

        {/* Building Detail Modal */}
        {inspectedBuildingData && (
          <BuildingDetailModal
            building={inspectedBuildingData.details}
            buildingPop={inspectedBuildingData.bldgPop}
            activeSquadCharacters={userCharacters}
            gameTimeMinutes={gameTimeMinutes}
            savedBuildingState={activeSquad?.customBuildings?.[inspectedBuildingData.details.id]}
            onSaveBuildingState={async (bldgId, state) => {
              if (state && state.reconPercent > 0) {
                markBuildingAsSearched(bldgId);
              }
              if (activeSquad && activeSessionId) {
                const updatedCustom = { ...(activeSquad.customBuildings || {}) };
                updatedCustom[bldgId] = state;
                await saveSquadProfile(activeSessionId, {
                  ...activeSquad,
                  customBuildings: updatedCustom
                });
              }
            }}
            onClose={() => setInspectedBuildingData(null)}
            onAwardXP={handleAwardXP}
            onSaveCharacter={handleSaveCharacter}
            onSaveCharacters={handleSaveCharacters}
            onRecordTravelRoute={handleRecordTravelRoute}
            onCombatInfectedKilled={handleCombatInfectedKilled}
            activeTravels={activeSquad?.activeTravels || []}
            activeScavenges={activeSquad?.activeScavenges || []}
            onStartTravel={handleStartTravel}
            onStartScavenge={handleStartScavenge}
            onRecruitCharacter={async (newChar) => {
              setUserCharacters(prev => [...prev, newChar]);
              await saveSurvivorCharacter(newChar);
              if (activeSquad && activeSessionId) {
                const updatedChars = [...userCharacters, newChar];
                await saveSquadProfile(activeSessionId, {
                  ...activeSquad,
                  characters: updatedChars
                });
              }
            }}
            isHQ={activeSquad?.hqFeatureId === inspectedBuildingData.details.id}
            isChoosingHQMode={gameSetupMode === 'choosing_hq'}
            onSetHQ={async (bldg) => {
              if (!candidateHQ || candidateHQ.featureId !== bldg.id) {
                setCandidateHQ({
                  feature: null,
                  featureId: bldg.id,
                  lat: 46.613,
                  lon: 6.794,
                  name: bldg.name,
                  type: bldg.categoryLabel,
                  area: bldg.groundAreaM2,
                  capacity: bldg.maxHousingCapacity
                });
              }
              await handleConfirmHQ();
              setInspectedBuildingData(null);
            }}
          />
        )}

        {/* POI Detail Modal */}
        {inspectedPoiData && (
          <PoiDetailModal
            poi={inspectedPoiData.details}
            activeSquadCharacters={userCharacters}
            savedPoiState={activeSquad?.customBuildings?.[inspectedPoiData.details.id]}
            onSavePoiState={async (bldgId, state) => {
              if (activeSquad && activeSessionId) {
                const updatedCustom = { ...(activeSquad.customBuildings || {}) };
                updatedCustom[bldgId] = state;
                await saveSquadProfile(activeSessionId, {
                  ...activeSquad,
                  customBuildings: updatedCustom
                });
              }
            }}
            onClose={() => setInspectedPoiData(null)}
          />
        )}

        {/* Street Zombie Horde Combat Modal */}
        {selectedHordeForCombat && (
          <StreetCombatModal
            horde={selectedHordeForCombat}
            squadCharacters={userCharacters}
            gameTimeMinutes={gameTimeMinutes}
            onClose={() => setSelectedHordeForCombat(null)}
            onCombatInfectedKilled={handleCombatInfectedKilled}
            onSaveCharacter={handleSaveCharacter}
            onAwardXP={handleAwardXP}
            onTriggerNoise={(weaponName, decibels, radiusMeters) => triggerGunshotNoise(weaponName, decibels, radiusMeters)}
          />
        )}

        {/* Global Crafting Modal */}
        {showCraftingModal && (
          <CraftingModal
            activeSquadCharacters={userCharacters}
            charInventories={{}}
            buildingItems={[]}
            onUpdateInventories={(updatedCharInventories) => {
              // Sync updated inventories if needed
            }}
            onClose={() => setShowCraftingModal(false)}
          />
        )}

        {/* System Alerts */}
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[99999] flex flex-col gap-2 pointer-events-none w-full max-w-3xl px-4">
          {systemAlerts.map(alert => (
            <div key={alert.id} className="pointer-events-auto bg-[#1a1a1a] border-b border-white/5 rounded-md px-4 py-2.5 flex items-center gap-3 animate-fadeIn shadow-2xl">
              <div className="flex items-center gap-2 shrink-0">
                <span className="px-2 py-0.5 rounded-sm text-[11px] font-medium bg-[#3b2161] text-[#b48eed]">App</span>
                <span className="px-2 py-0.5 rounded-sm text-[11px] font-medium bg-[#1a3a6b] text-[#699cf5]">Log</span>
              </div>
              <p className="text-[13px] font-medium text-slate-200 leading-snug flex-1 break-words">{alert.message}</p>
              <button 
                onClick={() => setSystemAlerts(prev => prev.filter(a => a.id !== alert.id))}
                className="text-slate-500 hover:text-slate-300 transition-colors p-1"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        {/* Real-time Scavenge Live Discovery Toasts */}
        <ScavengeToastOverlay 
          toasts={scavengeToasts} 
          onDismiss={handleDismissScavengeToast} 
        />

        {/* Scavenge Completion Summary Modal */}
        <ScavengeSummaryModal 
          isOpen={isSummaryModalOpen} 
          onClose={() => setIsSummaryModalOpen(false)} 
          scavenge={summaryScavenge} 
          onRecruitSurvivor={handleRecruitFromScavenge} 
          onCollectLoot={handleCollectLootFromScavenge} 
        />

        {/* Character Detail Modal Sheet */}
        {inspectedCharacter && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[2800] flex items-center justify-center p-3 sm:p-6 overflow-y-auto animate-fadeIn">
            <div className="bg-slate-950 border border-cyan-500/40 rounded-3xl p-4 sm:p-6 max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl relative custom-scrollbar space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <User className="w-5 h-5 text-cyan-400" />
                  <h3 className="font-bold text-white text-base">Fiche Complète de {inspectedCharacter.name}</h3>
                </div>
                <button 
                  onClick={() => setInspectedCharacter(null)}
                  className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 text-xs font-bold transition-all cursor-pointer flex items-center gap-1"
                >
                  <X className="w-4 h-4" />
                  <span>Fermer</span>
                </button>
              </div>

              <CharacterCard 
                character={inspectedCharacter} 
                targetSquad={userCharacters}
                gameTimeMinutes={gameTimeMinutes}
                onUpdateCharacter={async (updated) => {
                  setInspectedCharacter(updated);
                  await handleSaveCharacter(updated);
                }}
                showActions={true}
              />
            </div>
          </div>
        )}

        {/* Missions & Progression Modal */}
        {showMissionsModal && (
          <MissionsModal
            progression={progression}
            maxSquadSlots={maxSquadSlots}
            onClose={() => setShowMissionsModal(false)}
            onClaimMissionReward={handleClaimMissionReward}
            onOpenAdjacentCitiesModal={() => {
              setShowMissionsModal(false);
              setShowAdjacentCitiesModal(true);
            }}
          />
        )}

        {/* Adjacent Cities Navigation Modal */}
        {showAdjacentCitiesModal && (
          <AdjacentCitiesModal
            currentCityId={selectedCityId || ''}
            currentCityName={selectedCityName || ''}
            unlockedBadges={progression.badges}
            onClose={() => setShowAdjacentCitiesModal(false)}
            onSelectCity={(cId, cName) => {
              setSelectedCityId(cId);
              setSelectedCityName(cName);
            }}
          />
        )}

        {/* Victory & City Pacification Celebration Banner */}
        {showVictoryBanner && (
          <div className="fixed inset-0 z-[3500] bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn">
            <div className="bg-[#0b1329] border-2 border-amber-500 rounded-3xl p-6 sm:p-8 max-w-lg w-full text-center space-y-5 shadow-[0_0_50px_rgba(245,158,11,0.3)]">
              <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-tr from-amber-500 to-emerald-400 p-0.5 shadow-xl flex items-center justify-center">
                <div className="w-full h-full bg-slate-950 rounded-full flex items-center justify-center text-3xl">
                  🏅
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-black uppercase text-amber-400 tracking-widest">
                  VICTOIRE HISTORIQUE - COMMUNE PACIFIÉE !
                </div>
                <h2 className="text-2xl font-black text-white">
                  Libérateur de {selectedCityName || 'Commune'}
                </h2>
                <p className="text-xs text-slate-300 leading-relaxed max-w-md mx-auto">
                  Félicitations Commandant ! Vous avez éradiqué la menace zombie et porté la fortification de la commune à <strong>{cityPopulationState?.cityFortification || 80}%</strong>.
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-amber-950/40 border border-amber-500/40 text-amber-200 text-xs font-mono space-y-1">
                <div>🏆 Badge Débloqué : <strong>Libérateur de {selectedCityName}</strong></div>
                <div>⭐ Bonus de Récompense : <strong>+250 XP Commandant</strong></div>
              </div>

              <div className="pt-2 flex flex-col sm:flex-row gap-3">
                <button
                  onClick={() => {
                    setShowVictoryBanner(false);
                    setShowAdjacentCitiesModal(true);
                  }}
                  className="flex-1 px-4 py-3 rounded-2xl bg-gradient-to-r from-amber-500 to-emerald-500 text-slate-950 font-black text-xs shadow-xl hover:scale-105 transition-all cursor-pointer flex items-center justify-center gap-2"
                >
                  <Compass className="w-4 h-4" />
                  <span>Continuer : Sauver une Commune Voisine</span>
                </button>
                <button
                  onClick={() => setShowVictoryBanner(false)}
                  className="px-4 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs transition-colors cursor-pointer"
                >
                  Fermer
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_150px_rgba(0,0,0,0.8)] z-[1000]"></div>
      </div>

        {/* Right Panel (Squad Characters) */}
        {gameSetupMode === 'in_game' && (
          <div className="w-56 sm:w-64 h-full border-l border-slate-800 bg-[#020617]/90 backdrop-blur-md flex flex-col z-[1000] relative shrink-0 transition-all duration-300">
            {/* Header: Squad Switcher */}
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users2 className="w-5 h-5 text-cyan-400" />
                <span className="text-xs font-bold uppercase tracking-widest text-white">Équipes</span>
              </div>
              <select
                className="bg-slate-900 border border-slate-700 text-xs text-white rounded-lg px-2 py-1 outline-none focus:border-cyan-500 cursor-pointer max-w-[130px] truncate"
                value={activeSquadId || ''}
                onChange={(e) => {
                  const sqId = e.target.value;
                  setActiveSquadId(sqId);
                  const sq = mySquads.find(s => s.squadId === sqId);
                  if (sq && sq.cityId) {
                    setSelectedCityId(sq.cityId);
                    setSelectedCityName(sq.cityName);
                  }
                }}
              >
                {mySquads.map(sq => (
                  <option key={sq.squadId} value={sq.squadId}>{sq.squadName || 'Équipe'}</option>
                ))}
              </select>
            </div>

            {/* Body: Characters List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
              <div className="text-[10px] text-slate-400 font-mono mb-2 border-b border-slate-800 pb-2">
                QG ({userCharacters.length}/{Math.max(10, activeSquad?.maxCapacity || 10)})
              </div>
              
              {userCharacters.map((c, i) => {
                const color = getCharacterColor(i);
                const isAtHq = !c.locationType || c.locationType === 'hq';
                const isAtBuilding = c.locationType === 'building';
                const isAtStreet = c.locationType === 'street' || c.locationType === 'exterior';
                
                const healthPct = c.vitals?.sante ?? c.health ?? 100;
                const hungerPct = c.vitals?.faim ?? 100;
                const thirstPct = c.vitals?.soif ?? 100;
                const fatiguePct = c.vitals?.fatigue ?? 0;
                
                return (
                  <div 
                    key={c.id || i}
                    className="bg-slate-900/70 border border-slate-800 p-2 rounded-xl space-y-1.5 hover:border-cyan-500/50 transition-colors"
                  >
                    {/* Header row */}
                    <div className="flex items-center justify-between cursor-pointer" onClick={() => setInspectedCharacter(c)}>
                      <div className="flex items-center gap-2">
                        <span 
                          style={{ backgroundColor: color.hex }}
                          className="w-5 h-5 rounded-full border border-white flex items-center justify-center text-[10px] font-extrabold text-white shadow shrink-0"
                        >
                          {i + 1}
                        </span>
                        <span className="font-bold text-white text-xs hover:text-cyan-300">{c.name}</span>
                        {c.busyUntilMinute && c.busyUntilMinute > gameTimeMinutes && <span className="text-[8px] font-mono font-bold text-rose-300 bg-rose-950 px-1 py-0.5 rounded animate-pulse">{c.currentActionName || 'Occupé'}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] font-mono text-cyan-300 bg-slate-800 px-1.5 py-0.5 rounded">
                          {c.role}
                        </span>
                      </div>
                    </div>

                    {/* Vitals */}
                    <div className="grid grid-cols-2 gap-2 pt-1" onClick={() => setInspectedCharacter(c)}>
                      <div>
                        <div className="flex justify-between text-[9px] text-slate-400 mb-0.5"><span>Santé</span><span className="text-emerald-400">{healthPct}%</span></div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden"><div className="bg-emerald-500 h-1.5 rounded-full" style={{width: `${healthPct}%`}}></div></div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[9px] text-slate-400 mb-0.5"><span>Faim</span><span className="text-amber-400">{hungerPct}%</span></div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden"><div className="bg-amber-500 h-1.5 rounded-full" style={{width: `${hungerPct}%`}}></div></div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[9px] text-slate-400 mb-0.5"><span>Soif</span><span className="text-blue-400">{thirstPct}%</span></div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden"><div className="bg-blue-500 h-1.5 rounded-full" style={{width: `${thirstPct}%`}}></div></div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[9px] text-slate-400 mb-0.5"><span>Fatigue</span><span className="text-rose-400">{fatiguePct}%</span></div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden"><div className="bg-rose-500 h-1.5 rounded-full" style={{width: `${fatiguePct}%`}}></div></div>
                      </div>
                    </div>
                    
                    {/* Location status badge */}
                    <div className="flex items-center justify-between text-[10px] font-mono text-slate-300 pt-2 border-t border-slate-800/80">
                      <div className="flex items-center gap-1">
                        {isAtHq && (
                          <span className="text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                            🏠 QG
                          </span>
                        )}
                        {isAtBuilding && (
                          <span className="text-cyan-300 bg-cyan-950/80 px-1.5 py-0.5 rounded border border-cyan-500/40 truncate max-w-[120px]" title={c.buildingName}>
                            🔍 {c.buildingName || 'Structure'}
                          </span>
                        )}
                        {isAtStreet && (
                          <span className="text-amber-300 bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-500/40 truncate max-w-[120px]" title={c.buildingName}>
                            📍 {c.buildingName || 'Ville'}
                          </span>
                        )}
                        
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isAtHq && activeSquad?.hqLat && activeSquad?.hqLon) {
                              setCharacterToLocate({ lat: activeSquad.hqLat, lon: activeSquad.hqLon, id: c.id });
                            } else if (c.lat && c.lon) {
                              setCharacterToLocate({ lat: c.lat, lon: c.lon, id: c.id });
                            }
                          }}
                          className="text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-500/40 flex items-center justify-center hover:bg-cyan-900 transition-colors cursor-pointer ml-1"
                          title="Localiser sur la carte"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                        </button>
                      </div>
                      {!isAtHq && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            let updatedC = { ...c };
                            if (c.lat && c.lon && activeSquad?.hqLat && activeSquad?.hqLon) {
                              const distMeters = getDistance(c.lat, c.lon, activeSquad.hqLat, activeSquad.hqLon);
                              const distKm = distMeters / 1000;
                              updatedC = applyMovementCost(updatedC, distKm);
                              
                              // Approximate time: 5 km/h walking speed => (distKm / 5) hours
                              const hoursPassed = distKm / getGameRules().walkingSpeedKmH;
                              updatedC = applyTimeTick(updatedC, hoursPassed, true);
                            }

                            handleSaveCharacter({
                              ...updatedC,
                              locationType: 'hq',
                              buildingId: undefined,
                              buildingName: undefined,
                              lat: undefined,
                              lon: undefined
                            });
                          }}
                          className="text-[9px] font-sans font-bold text-slate-400 hover:text-white underline cursor-pointer"
                          title="Rapatrier au QG"
                        >
                          ↩️ Rapatrier
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}



export default function App() {
  return (
    <Auth>
      <MainApp />
    </Auth>
  );
}
