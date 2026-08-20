import AsyncStorage from '@react-native-async-storage/async-storage';

const APP_PREFERENCES_STORAGE_KEY = 'health-tracker.app-preferences.v1';

export type ColourTheme = 'amethyst' | 'midnight' | 'ocean';
export type DisplayDensity = 'comfortable' | 'compact';
export type DailyEssentialTemplate = {
  id: string;
  label: string;
};

export type AppPreferences = {
  colourTheme: ColourTheme;
  dailyEssentialTemplates: DailyEssentialTemplate[];
  displayDensity: DisplayDensity;
};

export const defaultDailyEssentialTemplates: DailyEssentialTemplate[] = [
  { id: 'vitamins', label: 'Vitamins taken' },
  { id: 'laundry', label: 'Laundry done' },
  { id: 'medication', label: 'Medication taken' },
  { id: 'movement', label: 'Movement or exercise' },
];

const defaultPreferences: AppPreferences = {
  colourTheme: 'midnight',
  dailyEssentialTemplates: defaultDailyEssentialTemplates,
  displayDensity: 'comfortable',
};

export async function loadAppPreferences(): Promise<AppPreferences> {
  try {
    const rawPreferences = await AsyncStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    if (!rawPreferences) {
      return defaultPreferences;
    }
    return normalisePreferences(JSON.parse(rawPreferences) as unknown);
  } catch {
    return defaultPreferences;
  }
}

export async function saveAppPreferences(patch: Partial<AppPreferences>): Promise<AppPreferences> {
  const preferences = { ...(await loadAppPreferences()), ...patch };
  const normalisedPreferences = normalisePreferences(preferences);
  await AsyncStorage.setItem(APP_PREFERENCES_STORAGE_KEY, JSON.stringify(normalisedPreferences));
  return normalisedPreferences;
}

function normalisePreferences(value: unknown): AppPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return defaultPreferences;
  }
  const preferences = value as Partial<AppPreferences>;
  return {
    colourTheme: isColourTheme(preferences.colourTheme) ? preferences.colourTheme : defaultPreferences.colourTheme,
    dailyEssentialTemplates: normaliseDailyEssentialTemplates(preferences.dailyEssentialTemplates),
    displayDensity: isDisplayDensity(preferences.displayDensity) ? preferences.displayDensity : defaultPreferences.displayDensity,
  };
}

function normaliseDailyEssentialTemplates(value: unknown): DailyEssentialTemplate[] {
  if (!Array.isArray(value)) {
    return defaultDailyEssentialTemplates;
  }
  const usedIds = new Set<string>();
  const templates = value.flatMap((item): DailyEssentialTemplate[] => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return [];
    }
    const template = item as Partial<DailyEssentialTemplate>;
    if (typeof template.id !== 'string' || template.id.length === 0 || template.id.length > 80
      || typeof template.label !== 'string' || template.label.trim().length === 0 || template.label.trim().length > 80
      || usedIds.has(template.id)) {
      return [];
    }
    usedIds.add(template.id);
    return [{ id: template.id, label: template.label.trim() }];
  });
  return templates;
}

function isColourTheme(value: unknown): value is ColourTheme {
  return value === 'amethyst' || value === 'midnight' || value === 'ocean';
}

function isDisplayDensity(value: unknown): value is DisplayDensity {
  return value === 'comfortable' || value === 'compact';
}
