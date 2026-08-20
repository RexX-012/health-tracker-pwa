import { ReactNode, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';
import { GlassView, isGlassEffectAPIAvailable } from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import * as Notifications from 'expo-notifications';
import { BackendRequestError, BackendUnavailableError, requestWithFailover } from './src/services/backendClient';
import {
  AppPreferences,
  ColourTheme,
  DailyEssentialTemplate,
  defaultDailyEssentialTemplates,
  DisplayDensity,
  loadAppPreferences,
  saveAppPreferences,
} from './src/services/appPreferences';
import { dailyDataStore, DailyData, StoredFoodEntry } from './src/services/dailyData';
import { HydrationNotificationResult, scheduleHydrationReminder } from './src/services/hydrationNotifications';
import {
  getPersonalAccessStorageDescription,
  getPersonalAccessToken,
  savePersonalAccessToken as savePersonalAccessTokenToStorage,
} from './src/services/personalAccessToken';

type Tab = 'physical' | 'food';
type FoodInputMode = 'photo' | 'text';
type AiUsage = {
  limit: number;
  remaining: number;
  used: number;
};
type FoodImage = {
  base64: string;
  mediaType: string;
  uri: string;
};
type DailyEssential = DailyEssentialTemplate & {
  completed: boolean;
};
type WaterEntry = {
  id: string;
  litres: number;
  recordedAt: string | null;
  unit: WaterUnit;
};
type WaterUnit = 'litres' | 'millilitres';
type FoodAnalysis = {
  calorieRange: { high: number; low: number };
  confidence: 'low' | 'medium' | 'high';
  estimatedCalories: number;
  items: Array<{ estimatedCalories: number; name: string }>;
  macronutrients?: {
    carbohydratesGrams: number;
    fatGrams: number;
    fibreGrams: number;
    proteinGrams: number;
  };
  mealStyle?: 'balanced' | 'hearty' | 'light';
  recognizedDescription?: string;
  recommendations?: {
    balancedPairing: string;
    cuisineAlternative: string;
    flavorPairing: string;
    lighterOption: string;
    spicePairing: string;
  };
  mealIdeas?: Array<{
    foods: string[];
    reason: string;
    title: string;
  }>;
  summary: string;
};
type FoodAnalysisResponse = {
  analysis: FoodAnalysis;
  cached: boolean;
  usage: AiUsage;
};
type ThemePalette = {
  accent: string;
  background: [string, string, string];
};

const showerOptions = ['No shower', 'Shower with product', 'Shower without product'];
const WATER_GOAL_LITRES = 3;
const waterUnitOptions: WaterUnit[] = ['litres', 'millilitres'];
const timeOptions = Array.from({ length: 24 }, (_, hour) => {
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${String(hour).padStart(2, '0')} ${suffix}`;
});
const PERSONAL_ACCESS_TOKEN_KEY = 'health-tracker.personal-access-token';
const timezoneOptions = [
  'Australia/Sydney',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Darwin',
  'Australia/Perth',
  'Pacific/Auckland',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'UTC',
] as const;
const colourThemeOptions: ColourTheme[] = ['midnight', 'amethyst', 'ocean'];
const displayDensityOptions: DisplayDensity[] = ['comfortable', 'compact'];
const themePalettes: Record<ColourTheme, ThemePalette> = {
  amethyst: { accent: '#D7CAFF', background: ['#090711', '#17102A', '#31204A'] },
  midnight: { accent: '#D7CAFF', background: ['#000000', '#090A0F', '#1A1C25'] },
  ocean: { accent: '#B1D6FF', background: ['#00080D', '#08222F', '#12384A'] },
};

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const isDailyCheck = notification.request.content.data?.kind === 'daily-hydration-check';
      return {
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: !isDailyCheck,
        shouldShowList: !isDailyCheck,
      };
    },
  });
}

function createIdempotencyKey(): string {
  return `food-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function createFoodEntryId(): string {
  return `entry-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function createDailyEssentialId(): string {
  return `essential-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createWaterEntryId(): string {
  return `water-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getBackendErrorCode(error: unknown): string | null {
  if (!(error instanceof BackendRequestError)) {
    return null;
  }
  try {
    const payload = JSON.parse(error.message) as { code?: unknown };
    return typeof payload.code === 'string' ? payload.code : null;
  } catch {
    return null;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readPhysicalData(data: DailyData, templates: DailyEssentialTemplate[]) {
  const physical = isRecord(data.physical) ? data.physical : {};
  return {
    essentials: readDailyEssentials(physical, templates),
    shower: typeof physical.shower === 'string' && showerOptions.includes(physical.shower) ? physical.shower : showerOptions[0],
    sleepTime: typeof physical.sleepTime === 'string' && timeOptions.includes(physical.sleepTime) ? physical.sleepTime : timeOptions[0],
    wakeTime: typeof physical.wakeTime === 'string' && timeOptions.includes(physical.wakeTime) ? physical.wakeTime : timeOptions[0],
    waterGoalCelebrated: physical.waterGoalCelebrated === true,
    waterEntries: readWaterEntries(physical),
  };
}

function readWaterEntries(physical: Record<string, unknown>): WaterEntry[] {
  if (Array.isArray(physical.waterEntries)) {
    return physical.waterEntries.flatMap((item): WaterEntry[] => {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0
        || !isStoredWaterAmount(item.litres) || (item.recordedAt !== null && typeof item.recordedAt !== 'string')) {
        return [];
      }
      return [{
        id: item.id,
        litres: item.litres,
        recordedAt: item.recordedAt,
        unit: item.unit === 'millilitres' ? 'millilitres' : 'litres',
      }];
    });
  }

  const legacyTotal = typeof physical.waterLitres === 'number' && Number.isFinite(physical.waterLitres) ? physical.waterLitres : 0;
  return isStoredWaterAmount(legacyTotal)
    ? [{ id: 'existing-water-total', litres: legacyTotal, recordedAt: null, unit: 'litres' }]
    : [];
}

function isStoredWaterAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000;
}

function isEditableWaterAmount(value: unknown): value is number {
  return isStoredWaterAmount(value) && value <= 10;
}

function getWaterTotal(entries: WaterEntry[]): number {
  return Math.round(entries.reduce((total, entry) => total + entry.litres, 0) * 1000) / 1000;
}

function readDailyEssentials(physical: Record<string, unknown>, templates: DailyEssentialTemplate[]): DailyEssential[] {
  if (Array.isArray(physical.essentials)) {
    const essentials = physical.essentials.flatMap((item): DailyEssential[] => {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0
        || typeof item.label !== 'string' || item.label.trim().length === 0 || typeof item.completed !== 'boolean') {
        return [];
      }
      return [{ id: item.id, label: item.label.trim(), completed: item.completed }];
    });
    if (essentials.length > 0) {
      return essentials;
    }
  }
  return templates.map((item) => ({
    ...item,
    completed: item.id === 'vitamins' ? physical.vitaminsTaken === true : item.id === 'laundry' && physical.laundryDone === true,
  }));
}

function formatDayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', weekday: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, day));
}

function formatWaterTotal(litres: number): string {
  return `${litres.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')} L`;
}

function formatWaterEntryAmount(entry: WaterEntry): string {
  return entry.unit === 'millilitres'
    ? `${Math.round(entry.litres * 1000)} mL`
    : formatWaterTotal(entry.litres);
}

function formatWaterUnit(unit: WaterUnit): string {
  return unit === 'millilitres' ? 'mL' : 'L';
}

function getWaterAmountInLitres(amount: number, unit: WaterUnit): number {
  return unit === 'millilitres' ? amount / 1000 : amount;
}

function formatWaterAmountForEditing(entry: WaterEntry): string {
  const amount = entry.unit === 'millilitres' ? entry.litres * 1000 : entry.litres;
  return String(amount);
}

function formatWaterEntryTime(recordedAt: string | null): string {
  if (!recordedAt) {
    return 'Existing total';
  }
  const timestamp = new Date(recordedAt);
  if (Number.isNaN(timestamp.getTime())) {
    return 'Added today';
  }
  return `Added ${timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function formatTimezone(timezone: string): string {
  return timezone.replace(/_/g, ' ').replace('/', ' · ');
}

function formatColourTheme(theme: string): string {
  return theme.charAt(0).toUpperCase() + theme.slice(1);
}

function formatDisplayDensity(density: string): string {
  return density === 'compact' ? 'Compact' : 'Comfortable';
}

function formatHydrationReminderStatus(result: HydrationNotificationResult): string {
  if (result === 'scheduled-complete') {
    return 'Your 9:00 PM hydration congratulations check is scheduled.';
  }
  if (result === 'scheduled-reminders') {
    return 'Hourly water reminders and your 9:00 PM check are scheduled.';
  }
  if (result === 'permission-denied') {
    return 'Allow notifications in iPhone Settings to receive your 9:00 PM hydration check.';
  }
  return Platform.OS === 'web'
    ? 'Timed hydration reminders are available in the native iPhone app.'
    : 'Hydration notifications are available on your iPhone app.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getUnansweredFoodEntry(data: DailyData): StoredFoodEntry | null {
  if (!Array.isArray(data.foodEntries)) {
    return null;
  }
  for (let index = data.foodEntries.length - 1; index >= 0; index -= 1) {
    const entry = data.foodEntries[index];
    if (isRecord(entry) && entry.itchLevel === null && typeof entry.id === 'string') {
      return entry as StoredFoodEntry;
    }
  }
  return null;
}

function getLatestUnansweredFoodEntry(records: Record<string, { data: DailyData }>): StoredFoodEntry | null {
  for (const date of Object.keys(records).sort().reverse()) {
    const entry = getUnansweredFoodEntry(records[date].data);
    if (entry) {
      return entry;
    }
  }
  return null;
}

function GlassSurface({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  if (isGlassEffectAPIAvailable()) {
    return (
      <GlassView glassEffectStyle="clear" style={style}>
        {children}
      </GlassView>
    );
  }

  return <View style={[styles.glassFallback, style]}>{children}</View>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('physical');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [colourTheme, setColourTheme] = useState<ColourTheme>('midnight');
  const [displayDensity, setDisplayDensity] = useState<DisplayDensity>('comfortable');
  const [dailyEssentials, setDailyEssentials] = useState<DailyEssential[]>(() => readDailyEssentials({}, defaultDailyEssentialTemplates));
  const [essentialTemplates, setEssentialTemplates] = useState<DailyEssentialTemplate[]>(defaultDailyEssentialTemplates);
  const [isAddingEssential, setIsAddingEssential] = useState(false);
  const [newEssentialLabel, setNewEssentialLabel] = useState('');
  const [shower, setShower] = useState(showerOptions[0]);
  const [wakeTime, setWakeTime] = useState(timeOptions[0]);
  const [sleepTime, setSleepTime] = useState(timeOptions[0]);
  const [waterEntry, setWaterEntry] = useState('');
  const [waterEntryUnit, setWaterEntryUnit] = useState<WaterUnit>('litres');
  const [waterEntries, setWaterEntries] = useState<WaterEntry[]>([]);
  const [editingWaterEntry, setEditingWaterEntry] = useState<WaterEntry | null>(null);
  const [editedWaterAmount, setEditedWaterAmount] = useState('');
  const [editedWaterUnit, setEditedWaterUnit] = useState<WaterUnit>('litres');
  const [currentDate, setCurrentDate] = useState('');
  const [dailyTimezone, setDailyTimezone] = useState('Australia/Sydney');
  const [dailySyncStatus, setDailySyncStatus] = useState('Saving daily data on this iPhone…');
  const [hydrationReminderStatus, setHydrationReminderStatus] = useState('Preparing your 9:00 PM hydration check…');
  const [foodDescription, setFoodDescription] = useState('');
  const [foodImage, setFoodImage] = useState<FoodImage | null>(null);
  const [foodInputMode, setFoodInputMode] = useState<FoodInputMode>('text');
  const [spiceLevel, setSpiceLevel] = useState(0);
  const [accessTokenInput, setAccessTokenInput] = useState('');
  const [hasPersonalAccessToken, setHasPersonalAccessToken] = useState(false);
  const [isAccessTokenLoading, setIsAccessTokenLoading] = useState(true);
  const [isSavingAccessToken, setIsSavingAccessToken] = useState(false);
  const [aiUsage, setAiUsage] = useState<AiUsage | null>(null);
  const [isAiUsageLoading, setIsAiUsageLoading] = useState(false);
  const [aiUsageStatus, setAiUsageStatus] = useState('');
  const [aiAnalysis, setAiAnalysis] = useState<FoodAnalysis | null>(null);
  const [aiAnalysisStatus, setAiAnalysisStatus] = useState('');
  const [isAiAnalysisLoading, setIsAiAnalysisLoading] = useState(false);
  const [isSavingFoodEntry, setIsSavingFoodEntry] = useState(false);
  const [pendingItchEntry, setPendingItchEntry] = useState<StoredFoodEntry | null>(null);
  const [selectedItchLevel, setSelectedItchLevel] = useState<number | null>(null);
  const [savedFoodEntryId, setSavedFoodEntryId] = useState<string | null>(null);
  const capReachedAlertShown = useRef(false);
  const aiAnalysisRequestId = useRef<string | null>(null);
  const dailyWriteQueue = useRef(Promise.resolve());
  const loadedDailyDate = useRef<string | null>(null);
  const essentialTemplatesRef = useRef<DailyEssentialTemplate[]>(defaultDailyEssentialTemplates);
  const hydrationNotificationQueue = useRef(Promise.resolve());
  const waterGoalCelebratedRef = useRef(false);
  const isPhysical = activeTab === 'physical';
  const activeTheme = themePalettes[colourTheme];
  const isCompactDisplay = displayDensity === 'compact';
  const waterLitres = getWaterTotal(waterEntries);
  const waterGoalProgress = Math.min(waterLitres / WATER_GOAL_LITRES, 1);
  const waterRemainingLitres = Math.max(WATER_GOAL_LITRES - waterLitres, 0);

  const hydrateCurrentDailyRecord = async () => {
    const state = await dailyDataStore.load();
    const date = dailyDataStore.getTodayDate(state);
    if (loadedDailyDate.current === date) {
      return;
    }
    const dailyData = state.records[date]?.data ?? {};
    const physical = readPhysicalData(dailyData, essentialTemplatesRef.current);
    loadedDailyDate.current = date;
    setCurrentDate(date);
    setDailyTimezone(state.timezone);
    setDailyEssentials(physical.essentials);
    setIsAddingEssential(false);
    setNewEssentialLabel('');
    setShower(physical.shower);
    setWakeTime(physical.wakeTime);
    setSleepTime(physical.sleepTime);
    waterGoalCelebratedRef.current = physical.waterGoalCelebrated;
    setWaterEntries(physical.waterEntries);
    setWaterEntry('');
    setWaterEntryUnit('litres');
    setEditingWaterEntry(null);
    setEditedWaterAmount('');
    setEditedWaterUnit('litres');
    setPendingItchEntry(getUnansweredFoodEntry(dailyData) ?? getLatestUnansweredFoodEntry(state.records));
    setSelectedItchLevel(null);
    setDailySyncStatus(state.records[date]?.pending ? 'Saved on this iPhone. Waiting to sync.' : 'Daily data is up to date.');
    void scheduleHydrationCheck(getWaterTotal(physical.waterEntries), state.timezone);
  };

  const syncDailyData = async () => {
    const accessToken = await getPersonalAccessToken(PERSONAL_ACCESS_TOKEN_KEY);
    if (!accessToken) {
      setDailySyncStatus('Saved on this iPhone. Save your personal code to sync.');
      return;
    }
    try {
      const result = await dailyDataStore.sync(accessToken);
      setDailySyncStatus(result.pending === 0 ? 'Daily data is synced safely.' : 'Saved on this iPhone. Waiting to sync.');
    } catch {
      setDailySyncStatus('Saved on this iPhone. It will sync when the connection returns.');
    }
  };

  const savePhysicalPatch = (patch: Record<string, unknown>) => {
    dailyWriteQueue.current = dailyWriteQueue.current
      .catch(() => undefined)
      .then(async () => {
        await dailyDataStore.savePatch({ physical: patch });
        setDailySyncStatus('Saved on this iPhone. Syncing…');
        await syncDailyData();
      });
  };

  const updateDailyEssentials = (nextEssentials: DailyEssential[]) => {
    setDailyEssentials(nextEssentials);
    const vitamins = nextEssentials.find((item) => item.id === 'vitamins');
    const laundry = nextEssentials.find((item) => item.id === 'laundry');
    savePhysicalPatch({
      essentials: nextEssentials,
      laundryDone: laundry?.completed ?? false,
      vitaminsTaken: vitamins?.completed ?? false,
    });
  };

  const toggleDailyEssential = (id: string) => {
    updateDailyEssentials(dailyEssentials.map((item) => item.id === id ? { ...item, completed: !item.completed } : item));
  };

  const addDailyEssential = () => {
    const label = newEssentialLabel.trim().replace(/\s+/g, ' ');
    if (!label) {
      Alert.alert('Name an essential', 'Enter something you would like to track each day.');
      return;
    }
    if (dailyEssentials.some((item) => item.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
      Alert.alert('Already listed', 'That daily essential is already in your list.');
      return;
    }
    const customTemplate = { id: createDailyEssentialId(), label };
    const nextTemplates = [...essentialTemplates, customTemplate];
    essentialTemplatesRef.current = nextTemplates;
    setEssentialTemplates(nextTemplates);
    void saveAppPreferences({ dailyEssentialTemplates: nextTemplates }).catch(() => {
      Alert.alert('Essential not saved', 'It is visible for today, but could not be saved as a reusable daily item.');
    });
    updateDailyEssentials([...dailyEssentials, { ...customTemplate, completed: false }]);
    setNewEssentialLabel('');
    setIsAddingEssential(false);
  };

  const deleteDailyEssential = (id: string) => {
    const nextEssentials = dailyEssentials.filter((item) => item.id !== id);
    const nextTemplates = essentialTemplates.filter((item) => item.id !== id);
    essentialTemplatesRef.current = nextTemplates;
    setEssentialTemplates(nextTemplates);
    void saveAppPreferences({ dailyEssentialTemplates: nextTemplates }).catch(() => {
      Alert.alert('Essential removal not saved', 'The item is removed for today, but could not be removed from future days.');
    });
    updateDailyEssentials(nextEssentials);
  };

  const saveWaterEntries = (nextEntries: WaterEntry[]) => {
    const total = getWaterTotal(nextEntries);
    const reachedGoalNow = total >= WATER_GOAL_LITRES && !waterGoalCelebratedRef.current;
    if (total < WATER_GOAL_LITRES) {
      waterGoalCelebratedRef.current = false;
    } else if (reachedGoalNow) {
      waterGoalCelebratedRef.current = true;
    }
    setWaterEntries(nextEntries);
    savePhysicalPatch({
      waterEntries: nextEntries,
      waterGoalCelebrated: waterGoalCelebratedRef.current,
      waterLitres: total,
    });
    void scheduleHydrationCheck(total, dailyTimezone);
    return { reachedGoalNow, total };
  };

  const scheduleHydrationCheck = (litres: number, timezone: string) => {
    hydrationNotificationQueue.current = hydrationNotificationQueue.current
      .catch(() => undefined)
      .then(async () => {
        const result = await scheduleHydrationReminder(litres, timezone);
        setHydrationReminderStatus(formatHydrationReminderStatus(result));
      })
      .catch(() => setHydrationReminderStatus('Your 9:00 PM hydration check could not be scheduled.'));
  };

  const addWaterEntry = () => {
    const enteredAmount = Number(waterEntry.replace(',', '.'));
    const amount = getWaterAmountInLitres(enteredAmount, waterEntryUnit);
    if (!isEditableWaterAmount(amount)) {
      Alert.alert('Enter a valid amount', waterEntryUnit === 'millilitres'
        ? 'Add an amount between 1 and 10,000 mL.'
        : 'Add an amount between 0 and 10 litres.');
      return;
    }
    const nextEntries = [...waterEntries, {
      id: createWaterEntryId(),
      litres: amount,
      recordedAt: new Date().toISOString(),
      unit: waterEntryUnit,
    }];
    setWaterEntry('');
    const result = saveWaterEntries(nextEntries);
    if (result.reachedGoalNow) {
      Alert.alert('Hydration goal reached!', `Great work — you have reached ${formatWaterTotal(result.total)} today, meeting your ${WATER_GOAL_LITRES} L goal.`);
    }
  };

  const openWaterEntryEditor = (entry: WaterEntry) => {
    setEditingWaterEntry(entry);
    setEditedWaterAmount(formatWaterAmountForEditing(entry));
    setEditedWaterUnit(entry.unit);
  };

  const saveEditedWaterEntry = () => {
    if (!editingWaterEntry) {
      return;
    }
    const enteredAmount = Number(editedWaterAmount.replace(',', '.'));
    const amount = getWaterAmountInLitres(enteredAmount, editedWaterUnit);
    const isExistingTotal = editingWaterEntry.id === 'existing-water-total';
    if (isExistingTotal ? !isStoredWaterAmount(amount) : !isEditableWaterAmount(amount)) {
      Alert.alert('Enter a valid amount', isExistingTotal
        ? `Use an amount greater than 0 ${formatWaterUnit(editedWaterUnit)}.`
        : editedWaterUnit === 'millilitres'
          ? 'Use an amount between 1 and 10,000 mL.'
          : 'Use an amount between 0 and 10 litres.');
      return;
    }
    const result = saveWaterEntries(waterEntries.map((entry) => entry.id === editingWaterEntry.id
      ? { ...entry, litres: amount, unit: editedWaterUnit }
      : entry));
    setEditingWaterEntry(null);
    setEditedWaterAmount('');
    setEditedWaterUnit('litres');
    if (result.reachedGoalNow) {
      Alert.alert('Hydration goal reached!', `Great work — you have reached ${formatWaterTotal(result.total)} today, meeting your ${WATER_GOAL_LITRES} L goal.`);
    }
  };

  const deleteWaterEntry = (entryId: string) => {
    saveWaterEntries(waterEntries.filter((entry) => entry.id !== entryId));
  };

  const updateTimezone = async (timezone: string) => {
    try {
      const state = await dailyDataStore.setTimezone(timezone);
      loadedDailyDate.current = null;
      setDailyTimezone(state.timezone);
      setDailySyncStatus('Day boundary updated. Syncing your saved data…');
      await hydrateCurrentDailyRecord();
      await syncDailyData();
    } catch {
      Alert.alert('Timezone not updated', 'Your current timezone and saved daily data are still safe on this iPhone.');
    }
  };

  const updatePreferences = async (patch: Partial<AppPreferences>) => {
    try {
      const preferences = await saveAppPreferences(patch);
      setColourTheme(preferences.colourTheme);
      setDisplayDensity(preferences.displayDensity);
    } catch {
      Alert.alert('Preference not saved', 'The change is visible for now but could not be saved for future app launches.');
    }
  };

  useEffect(() => {
    const loadPersonalAccessToken = async () => {
      try {
        const savedToken = await getPersonalAccessToken(PERSONAL_ACCESS_TOKEN_KEY);
        setHasPersonalAccessToken(Boolean(savedToken));
      } catch {
        Alert.alert('Access storage unavailable', `Your personal access code could not be read from ${getPersonalAccessStorageDescription()}.`);
      } finally {
        setIsAccessTokenLoading(false);
      }
    };

    void loadPersonalAccessToken();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return undefined;
    }
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      if (notification.request.content.data?.kind === 'daily-hydration-check') {
        const complete = notification.request.content.data?.complete === true;
        Alert.alert(
          complete ? 'Congratulations!' : 'Water reminder',
          notification.request.content.body ?? (complete
            ? 'You completed your hydration goal today.'
            : 'Open the app to review today’s water intake.'),
        );
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const loadPreferences = async () => {
      const preferences = await loadAppPreferences();
      setColourTheme(preferences.colourTheme);
      setDisplayDensity(preferences.displayDensity);
      essentialTemplatesRef.current = preferences.dailyEssentialTemplates;
      setEssentialTemplates(preferences.dailyEssentialTemplates);
      loadedDailyDate.current = null;
      await hydrateCurrentDailyRecord();
    };

    void loadPreferences();
  }, []);

  useEffect(() => {
    void hydrateCurrentDailyRecord();
    const timer = setInterval(() => void hydrateCurrentDailyRecord(), 60_000);
    return () => clearInterval(timer);
  }, []);

  const selectFoodImage = async () => {
    if (Platform.OS !== 'web') {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Photo access needed', 'Allow photo access to choose a food image.');
        return;
      }
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [4, 3],
      base64: true,
      mediaTypes: ['images'],
      quality: 0.5,
    });

    if (!result.canceled) {
      const asset = result.assets[0];
      if (!asset.base64) {
        Alert.alert('Could not prepare photo', 'Choose the food photo again and try once more.');
        return;
      }
      aiAnalysisRequestId.current = null;
      setAiAnalysis(null);
      setAiAnalysisStatus('');
      setSavedFoodEntryId(null);
      if (foodInputMode === 'photo') {
        setFoodDescription('');
      }
      setFoodImage({ base64: asset.base64, mediaType: asset.mimeType ?? 'image/jpeg', uri: asset.uri });
    }
  };

  const updateFoodDescription = (description: string) => {
    aiAnalysisRequestId.current = null;
    setAiAnalysis(null);
    setAiAnalysisStatus('');
    setSavedFoodEntryId(null);
    setFoodDescription(description);
  };

  const changeFoodInputMode = (mode: FoodInputMode) => {
    aiAnalysisRequestId.current = null;
    setAiAnalysis(null);
    setAiAnalysisStatus('');
    setSavedFoodEntryId(null);
    setFoodDescription('');
    setFoodImage(null);
    setSpiceLevel(0);
    setFoodInputMode(mode);
  };

  const savePersonalAccessToken = async () => {
    const token = accessTokenInput.trim();
    if (token.length < 32) {
      Alert.alert('Use a longer personal code', 'Paste the complete access code generated for your backends.');
      return;
    }

    setIsSavingAccessToken(true);
    try {
      await savePersonalAccessTokenToStorage(PERSONAL_ACCESS_TOKEN_KEY, token);
      setAccessTokenInput('');
      setHasPersonalAccessToken(true);
      await syncDailyData();
      Alert.alert(
        'Personal access saved',
        Platform.OS === 'web'
          ? 'This code is stored in this browser on this device. Do not use a shared browser.'
          : 'This code is stored securely on this iPhone.',
      );
    } catch {
      Alert.alert('Could not save code', Platform.OS === 'web'
        ? 'Please try again in this browser.'
        : 'Please try again while your iPhone is unlocked.');
    } finally {
      setIsSavingAccessToken(false);
    }
  };

  const refreshAiUsage = async () => {
    setIsAiUsageLoading(true);
    setAiUsageStatus('');
    try {
      const accessToken = await getPersonalAccessToken(PERSONAL_ACCESS_TOKEN_KEY);
      if (!accessToken) {
        setAiUsage(null);
        setAiUsageStatus('Save your personal code to view the AI daily limit.');
        return;
      }

      const response = await requestWithFailover<AiUsage>('/ai-usage', {
        headers: { 'X-Health-Tracker-Access-Token': accessToken },
      });
      setAiUsage(response.data);

      if (response.data.remaining === 0 && !capReachedAlertShown.current) {
        capReachedAlertShown.current = true;
        Alert.alert('Daily AI limit reached', 'You have used all 10 AI food analyses for today. Please try again tomorrow.');
      }
      if (response.data.remaining > 0) {
        capReachedAlertShown.current = false;
      }
    } catch {
      setAiUsage(null);
      setAiUsageStatus('AI usage is unavailable right now. Pull back later or tap Refresh.');
    } finally {
      setIsAiUsageLoading(false);
    }
  };

  const analyseFoodWithAi = async (retryCount = 0): Promise<void> => {
    if (foodInputMode === 'photo' && !foodImage) {
      Alert.alert('Add a food photo', 'Choose a food photo before analysing in Photo mode.');
      return;
    }
    if (foodInputMode === 'text' && !foodDescription.trim()) {
      Alert.alert('Describe your food', 'Enter a food description before analysing in Text mode.');
      return;
    }
    if (aiUsage?.remaining === 0) {
      Alert.alert('Daily AI limit reached', 'You have used all 10 AI food analyses for today. Please try again tomorrow.');
      return;
    }

      const accessToken = await getPersonalAccessToken(PERSONAL_ACCESS_TOKEN_KEY);
    if (!accessToken) {
      Alert.alert('Personal code needed', 'Save your personal access code before using AI analysis.');
      return;
    }

    const idempotencyKey = aiAnalysisRequestId.current ?? createIdempotencyKey();
    aiAnalysisRequestId.current = idempotencyKey;
    setIsAiAnalysisLoading(true);
    setAiAnalysisStatus(retryCount > 0 ? 'Finishing your existing analysis…' : 'Analysing your food…');

    try {
      const response = await requestWithFailover<FoodAnalysisResponse>('/analyze-food', {
        body: {
          description: foodInputMode === 'text' ? foodDescription.trim() || undefined : undefined,
          image: foodImage ? { base64: foodImage.base64, mediaType: foodImage.mediaType } : undefined,
        },
        headers: { 'X-Health-Tracker-Access-Token': accessToken },
        idempotencyKey,
        method: 'POST',
        timeoutMs: 22_000,
      });
      setAiAnalysis(response.data.analysis);
      if (foodInputMode === 'photo' && response.data.analysis.recognizedDescription) {
        setFoodDescription(response.data.analysis.recognizedDescription);
      }
      setSavedFoodEntryId(null);
      setAiAnalysisStatus(response.data.cached ? 'Showing your completed analysis.' : 'Analysis complete.');
      setAiUsage(response.data.usage);
      if (response.data.usage.remaining === 0 && !capReachedAlertShown.current) {
        capReachedAlertShown.current = true;
        Alert.alert('Daily AI limit reached', 'You have used all 10 AI food analyses for today. Please try again tomorrow.');
      }
    } catch (error) {
      const errorCode = getBackendErrorCode(error);
      if (errorCode === 'AI_DAILY_LIMIT_REACHED') {
        setAiAnalysisStatus('Daily AI limit reached.');
        await refreshAiUsage();
        return;
      }
      if ((errorCode === 'AI_ANALYSIS_IN_PROGRESS' || error instanceof BackendUnavailableError) && retryCount < 2) {
        await wait(1_500);
        await analyseFoodWithAi(retryCount + 1);
        return;
      }
      setAiAnalysisStatus(
        errorCode === 'AI_ANALYSIS_IN_PROGRESS'
          ? 'Your analysis is still processing. Tap Analyse with AI to check it again.'
          : 'AI analysis could not be completed. You can try again.',
      );
    } finally {
      setIsAiAnalysisLoading(false);
    }
  };

  const saveFoodEntry = async () => {
    if (!aiAnalysis) {
      Alert.alert('Analyse your food first', 'Save entry becomes available once the private AI result is ready.');
      return;
    }

    const entry: StoredFoodEntry = {
      analysis: { ...aiAnalysis },
      description: foodDescription.trim() || null,
      id: createFoodEntryId(),
      itchLevel: null,
      photoAttached: Boolean(foodImage),
      savedAt: new Date().toISOString(),
      spiceLevel,
    };

    setIsSavingFoodEntry(true);
    const saveTask = dailyWriteQueue.current
      .catch(() => undefined)
      .then(async () => {
        await dailyDataStore.appendFoodEntry(entry);
        setDailySyncStatus('Food entry saved on this iPhone. Syncing…');
        void syncDailyData();
      });
    dailyWriteQueue.current = saveTask;

    try {
      await saveTask;
      setSavedFoodEntryId(entry.id);
      setSelectedItchLevel(null);
      setPendingItchEntry(entry);
    } catch {
      Alert.alert('Could not save entry', 'Your food entry was not saved. Please try again.');
    } finally {
      setIsSavingFoodEntry(false);
    }
  };

  const saveItchLevel = async () => {
    if (!pendingItchEntry || selectedItchLevel === null) {
      return;
    }

    setIsSavingFoodEntry(true);
    const saveTask = dailyWriteQueue.current
      .catch(() => undefined)
      .then(async () => {
        await dailyDataStore.setFoodEntryItchLevel(pendingItchEntry.id, selectedItchLevel);
        setDailySyncStatus('Itch level saved on this iPhone. Syncing…');
        void syncDailyData();
      });
    dailyWriteQueue.current = saveTask;

    try {
      await saveTask;
      setPendingItchEntry(null);
      setSelectedItchLevel(null);
      Alert.alert('Food entry saved', 'Your itch level has been added to this food entry.');
    } catch {
      Alert.alert('Could not save itch level', 'Your food entry is safe, but please try saving the itch level again.');
    } finally {
      setIsSavingFoodEntry(false);
    }
  };

  useEffect(() => {
    if (!isSettingsOpen || isAccessTokenLoading) {
      return;
    }

    void refreshAiUsage();
  }, [isSettingsOpen, hasPersonalAccessToken, isAccessTokenLoading]);

  return (
    <View style={styles.app}>
      <LinearGradient
        colors={activeTheme.background}
        end={{ x: 1, y: 1 }}
        pointerEvents="none"
        start={{ x: 0, y: 0 }}
        style={StyleSheet.absoluteFill}
      />

      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="light-content" />

        {isSettingsOpen ? (
          <ScrollView
            contentContainerStyle={[styles.settingsScrollContent, isCompactDisplay && styles.compactSettingsScrollContent]}
            showsVerticalScrollIndicator={false}
            style={styles.formScroll}>
            <View style={styles.settingsHeader}>
              <Pressable
                accessibilityLabel="Close settings"
                accessibilityRole="button"
                onPress={() => setIsSettingsOpen(false)}
                style={({ pressed }) => [styles.backButton, pressed && styles.pressedTile]}>
                <Text style={styles.backButtonLabel}>‹ Back</Text>
              </Pressable>
              <Text style={styles.settingsHeaderTitle}>Settings</Text>
            </View>
            <Text style={styles.subtitle}>Private controls for this iPhone.</Text>

            <GlassSurface style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Appearance</Text>
              <Text style={styles.inputLabel}>Colour theme</Text>
              <ChoiceSelect
                accessibilityLabel="Colour theme"
                formatOption={formatColourTheme}
                onChange={(value) => void updatePreferences({ colourTheme: value as ColourTheme })}
                options={colourThemeOptions}
                value={colourTheme}
              />
              <Text style={[styles.inputLabel, styles.secondInputLabel]}>Display spacing</Text>
              <ChoiceSelect
                accessibilityLabel="Display spacing"
                formatOption={formatDisplayDensity}
                onChange={(value) => void updatePreferences({ displayDensity: value as DisplayDensity })}
                options={displayDensityOptions}
                value={displayDensity}
              />
              <Text style={styles.settingsHint}>Compact keeps the same controls while fitting more on screen.</Text>
            </GlassSurface>

            <GlassSurface style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Day boundary</Text>
              <Text style={styles.sectionHint}>Your chosen timezone determines when a new daily record begins and when the previous day is finalised.</Text>
              <ChoiceSelect
                accessibilityLabel="Timezone"
                formatOption={formatTimezone}
                onChange={(value) => void updateTimezone(value)}
                options={timezoneOptions}
                value={dailyTimezone}
              />
              <Text style={styles.settingsHint}>Current timezone: {formatTimezone(dailyTimezone)}</Text>
            </GlassSurface>

            <GlassSurface style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Personal access</Text>
              {isAccessTokenLoading ? (
                <Text style={styles.sectionHint}>Checking secure access on this iPhone…</Text>
              ) : (
                <>
                  <Text style={styles.sectionHint}>
                    {hasPersonalAccessToken
                      ? 'Your personal access code is stored securely on this iPhone.'
                      : 'Paste your personal code after adding the same code to both backends.'}
                  </Text>
                  <TextInput
                    accessibilityLabel="Personal access code"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setAccessTokenInput}
                    placeholder={hasPersonalAccessToken ? 'Paste a replacement code' : 'Paste personal access code'}
                    placeholderTextColor="#AEB7D6"
                    secureTextEntry
                    style={styles.accessTokenInput}
                    textContentType="password"
                    value={accessTokenInput}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={isSavingAccessToken}
                    onPress={savePersonalAccessToken}
                    style={({ pressed }) => [
                      styles.accessTokenButton,
                      isSavingAccessToken && styles.disabledAccessTokenButton,
                      pressed && styles.pressedTile,
                    ]}>
                    <Text style={styles.accessTokenButtonLabel}>
                      {isSavingAccessToken ? 'Saving securely…' : hasPersonalAccessToken ? 'Replace personal code' : 'Save personal code'}
                    </Text>
                  </Pressable>
                </>
              )}
            </GlassSurface>

            <GlassSurface style={styles.aiUsageCard}>
              <View style={styles.aiUsageHeader}>
                <View>
                  <Text style={styles.previewLabel}>AI DAILY LIMIT</Text>
                  <Text style={styles.aiUsageTitle}>
                    {isAiUsageLoading
                      ? 'Checking your usage…'
                      : aiUsage
                        ? `${aiUsage.used} of ${aiUsage.limit} analyses used`
                        : 'Usage unavailable'}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="Refresh AI usage"
                  accessibilityRole="button"
                  disabled={isAiUsageLoading}
                  onPress={() => void refreshAiUsage()}
                  style={({ pressed }) => [styles.refreshUsageButton, pressed && styles.pressedTile]}>
                  <Text style={styles.refreshUsageLabel}>Refresh</Text>
                </Pressable>
              </View>
              <View style={styles.aiUsageTrack}>
                <View
                  style={[
                    styles.aiUsageFill,
                    { backgroundColor: activeTheme.accent },
                    aiUsage?.remaining === 0 && styles.aiUsageFillAtLimit,
                    { width: `${aiUsage ? (aiUsage.used / aiUsage.limit) * 100 : 0}%` },
                  ]}
                />
              </View>
              <Text style={styles.aiUsageHint}>
                {aiUsage
                  ? aiUsage.remaining === 0
                    ? 'Daily limit reached. Your AI analyses reset tomorrow.'
                    : `${aiUsage.remaining} AI analyses remaining today.`
                  : aiUsageStatus || 'Your daily AI usage will appear here.'}
              </Text>
            </GlassSurface>
          </ScrollView>
        ) : isPhysical ? (
          <ScrollView
            contentContainerStyle={[styles.scrollContent, isCompactDisplay && styles.compactScrollContent]}
            showsVerticalScrollIndicator={false}
            style={styles.formScroll}>
            <View style={styles.pageHeader}>
              <View>
                <Text style={styles.eyebrow}>YOUR DAILY SPACE</Text>
                <Text style={styles.title}>Physical Health</Text>
              </View>
              <Pressable
                accessibilityLabel="Open settings"
                accessibilityRole="button"
                onPress={() => setIsSettingsOpen(true)}
                style={({ pressed }) => [styles.settingsButton, pressed && styles.pressedTile]}>
                <Text style={styles.settingsIcon}>⚙</Text>
              </Pressable>
            </View>
            <Text style={styles.currentDayLabel}>{currentDate ? formatDayLabel(currentDate) : 'Loading today…'}</Text>
            <Text style={styles.subtitle}>Your check-in is saved automatically as you go.</Text>

            <GlassSurface style={styles.sectionCard}>
              <View style={styles.sectionTitleRow}>
                <Text style={styles.sectionTitle}>Daily essentials</Text>
                {!isAddingEssential && (
                  <Pressable
                    accessibilityLabel="Add a daily essential"
                    accessibilityRole="button"
                    onPress={() => setIsAddingEssential(true)}
                    style={({ pressed }) => [styles.addEssentialButton, pressed && styles.pressedTile]}>
                    <Text style={styles.addEssentialLabel}>+ Add</Text>
                  </Pressable>
                )}
              </View>
              {dailyEssentials.map((item) => (
                <SwipeToDeleteRow key={item.id} onDelete={() => deleteDailyEssential(item.id)}>
                  <CheckRow
                    checked={item.completed}
                    label={item.label}
                    onPress={() => toggleDailyEssential(item.id)}
                  />
                </SwipeToDeleteRow>
              ))}
              {isAddingEssential && (
                <View style={styles.essentialComposer}>
                  <TextInput
                    accessibilityLabel="New daily essential"
                    autoFocus
                    onChangeText={setNewEssentialLabel}
                    onSubmitEditing={addDailyEssential}
                    placeholder="e.g. Sunscreen"
                    placeholderTextColor="#99A2BD"
                    returnKeyType="done"
                    style={styles.essentialInput}
                    value={newEssentialLabel}
                  />
                  <View style={styles.essentialComposerActions}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        setIsAddingEssential(false);
                        setNewEssentialLabel('');
                      }}
                      style={({ pressed }) => [styles.essentialCancelButton, pressed && styles.pressedTile]}>
                      <Text style={styles.essentialCancelLabel}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={addDailyEssential}
                      style={({ pressed }) => [styles.essentialSaveButton, pressed && styles.pressedTile]}>
                      <Text style={styles.essentialSaveLabel}>Add item</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </GlassSurface>

            <GlassSurface style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Shower</Text>
              <ChoiceSelect
                accessibilityLabel="Shower choice"
                onChange={(value) => {
                  setShower(value);
                  savePhysicalPatch({ shower: value });
                }}
                options={showerOptions}
                value={shower}
              />
            </GlassSurface>

            <GlassSurface style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Rest</Text>
              <Text style={styles.inputLabel}>Wake time</Text>
              <ChoiceSelect
                accessibilityLabel="Wake time"
                onChange={(value) => {
                  setWakeTime(value);
                  savePhysicalPatch({ wakeTime: value });
                }}
                options={timeOptions}
                value={wakeTime}
              />
              <Text style={[styles.inputLabel, styles.secondInputLabel]}>Sleep time</Text>
              <ChoiceSelect
                accessibilityLabel="Sleep time"
                onChange={(value) => {
                  setSleepTime(value);
                  savePhysicalPatch({ sleepTime: value });
                }}
                options={timeOptions}
                value={sleepTime}
              />
            </GlassSurface>

            <GlassSurface style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Water intake</Text>
              <View style={styles.waterGoalHeader}>
                <Text style={styles.waterTotal}>{formatWaterTotal(waterLitres)} today</Text>
                <Text style={styles.waterGoalLabel}>Goal: {WATER_GOAL_LITRES} L</Text>
              </View>
              <View accessibilityLabel={`Water goal progress: ${formatWaterTotal(waterLitres)} of ${WATER_GOAL_LITRES} litres`} style={styles.waterProgressTrack}>
                <View style={[styles.waterProgressFill, { backgroundColor: activeTheme.accent, width: `${waterGoalProgress * 100}%` }]} />
              </View>
              <Text style={styles.waterGoalStatus}>
                {waterRemainingLitres > 0
                  ? `${formatWaterTotal(waterRemainingLitres)} to reach your daily goal`
                  : waterLitres === WATER_GOAL_LITRES
                    ? 'Daily hydration goal reached'
                    : `${formatWaterTotal(waterLitres - WATER_GOAL_LITRES)} above your daily goal`}
              </Text>
              <View style={styles.waterInputRow}>
                <TextInput
                  accessibilityLabel={`Water intake in ${formatWaterUnit(waterEntryUnit)}`}
                  keyboardType="decimal-pad"
                  onChangeText={setWaterEntry}
                  placeholder={waterEntryUnit === 'millilitres' ? '250' : '0.0'}
                  placeholderTextColor="#AEB7D6"
                  style={styles.waterInput}
                  value={waterEntry}
                />
                <WaterUnitToggle accent={activeTheme.accent} onChange={setWaterEntryUnit} value={waterEntryUnit} />
                <Pressable
                  accessibilityLabel="Add water intake"
                  accessibilityRole="button"
                  onPress={addWaterEntry}
                  style={({ pressed }) => [styles.waterAddButton, { backgroundColor: activeTheme.accent }, pressed && styles.pressedTile]}>
                  <Text style={styles.waterAddLabel}>Add</Text>
                </Pressable>
              </View>
              {waterEntries.length > 0 && (
                <View style={styles.waterLog}>
                  <Text style={styles.waterLogTitle}>Today’s additions</Text>
                  {waterEntries.slice().reverse().map((entry) => (
                    <SwipeToDeleteRow key={entry.id} onDelete={() => deleteWaterEntry(entry.id)}>
                      <View style={styles.waterLogContent}>
                        <Pressable
                          accessibilityHint="Tap to edit. Swipe left almost completely to delete."
                          accessibilityLabel={`${formatWaterEntryAmount(entry)}, ${formatWaterEntryTime(entry.recordedAt)}`}
                          accessibilityRole="button"
                          onPress={() => openWaterEntryEditor(entry)}
                          style={({ pressed }) => [styles.waterLogRow, pressed && styles.pressedTile]}>
                          <View>
                            <Text style={styles.waterLogAmount}>{formatWaterEntryAmount(entry)}</Text>
                            <Text style={styles.waterLogTime}>{formatWaterEntryTime(entry.recordedAt)}</Text>
                          </View>
                          <Text style={styles.waterLogChevron}>›</Text>
                        </Pressable>
                        {editingWaterEntry?.id === entry.id && (
                          <View style={styles.waterInlineEditor}>
                            <TextInput
                              accessibilityLabel={`Edited water amount in ${formatWaterUnit(editedWaterUnit)}`}
                              keyboardType="decimal-pad"
                              onChangeText={setEditedWaterAmount}
                              onSubmitEditing={saveEditedWaterEntry}
                              placeholder={editedWaterUnit === 'millilitres' ? '250' : '0.0'}
                              placeholderTextColor="#99A2BD"
                              returnKeyType="done"
                              selectTextOnFocus
                              style={styles.waterInlineInput}
                              value={editedWaterAmount}
                            />
                            <WaterUnitToggle compact accent={activeTheme.accent} onChange={setEditedWaterUnit} value={editedWaterUnit} />
                            <Pressable
                              accessibilityRole="button"
                              onPress={() => {
                                setEditingWaterEntry(null);
                                setEditedWaterAmount('');
                                setEditedWaterUnit('litres');
                              }}
                              style={({ pressed }) => [styles.waterInlineCancelButton, pressed && styles.pressedTile]}>
                              <Text style={styles.waterInlineCancelLabel}>Cancel</Text>
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              onPress={saveEditedWaterEntry}
                              style={({ pressed }) => [styles.waterInlineSaveButton, pressed && styles.pressedTile]}>
                              <Text style={styles.waterInlineSaveLabel}>Save</Text>
                            </Pressable>
                          </View>
                        )}
                      </View>
                    </SwipeToDeleteRow>
                  ))}
                </View>
              )}
              <Text style={styles.dailySyncHint}>{dailySyncStatus}</Text>
              <Text style={styles.hydrationReminderHint}>{hydrationReminderStatus}</Text>
            </GlassSurface>
          </ScrollView>
        ) : (
          <ScrollView
            contentContainerStyle={[styles.foodScrollContent, isCompactDisplay && styles.compactScrollContent]}
            showsVerticalScrollIndicator={false}
            style={styles.formScroll}>
            <View style={styles.pageHeader}>
              <View>
                <Text style={styles.eyebrow}>YOUR DAILY SPACE</Text>
                <Text style={styles.title}>Food Analysis</Text>
              </View>
              <Pressable
                accessibilityLabel="Open settings"
                accessibilityRole="button"
                onPress={() => setIsSettingsOpen(true)}
                style={({ pressed }) => [styles.settingsButton, pressed && styles.pressedTile]}>
                <Text style={styles.settingsIcon}>⚙</Text>
              </Pressable>
            </View>
            <Text style={styles.subtitle}>Describe a meal or add a photo to begin.</Text>

            <GlassSurface style={styles.inputModeCard}>
              <Text style={styles.sectionTitle}>How would you like to add food?</Text>
              <View style={styles.inputModeRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: foodInputMode === 'photo' }}
                  onPress={() => changeFoodInputMode('photo')}
                  style={({ pressed }) => [styles.inputModeButton, foodInputMode === 'photo' && styles.selectedInputModeButton, pressed && styles.pressedTile]}>
                  <Text style={[styles.inputModeLabel, foodInputMode === 'photo' && styles.selectedInputModeLabel]}>Photo</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: foodInputMode === 'text' }}
                  onPress={() => changeFoodInputMode('text')}
                  style={({ pressed }) => [styles.inputModeButton, foodInputMode === 'text' && styles.selectedInputModeButton, pressed && styles.pressedTile]}>
                  <Text style={[styles.inputModeLabel, foodInputMode === 'text' && styles.selectedInputModeLabel]}>Text</Text>
                </Pressable>
              </View>
              <Text style={styles.sectionHint}>
                {foodInputMode === 'photo'
                  ? 'AI will identify the pictured food and fill in an editable description after analysis.'
                  : 'Describe the meal yourself. A photo is optional extra context.'}
              </Text>
            </GlassSurface>

            <GlassSurface style={[styles.sectionCard, styles.photoSectionCard]}>
              <Text style={styles.sectionTitle}>{foodInputMode === 'photo' ? 'Food photo' : 'Optional food photo'}</Text>
              {foodImage ? (
                <View style={styles.compactImagePreviewWrap}>
                  <Image source={{ uri: foodImage.uri }} style={styles.compactImagePreview} />
                  <Pressable disabled={isAiAnalysisLoading} onPress={selectFoodImage} style={styles.changeImageButton}>
                    <Text style={styles.changeImageLabel}>Choose another photo</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  disabled={isAiAnalysisLoading}
                  onPress={selectFoodImage}
                  style={({ pressed }) => [styles.compactImageSelectButton, pressed && styles.pressedTile]}>
                  <Text style={styles.compactImageSelectIcon}>＋</Text>
                  <Text style={styles.imageSelectTitle}>{foodInputMode === 'photo' ? 'Add a food photo' : 'Add an optional photo'}</Text>
                  <Text style={styles.imageSelectHint}>
                    {foodInputMode === 'photo' ? 'AI identifies this after you tap Analyse with AI.' : 'This can add visual context to your written description.'}
                  </Text>
                </Pressable>
              )}
            </GlassSurface>

            <GlassSurface style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>{foodInputMode === 'photo' ? 'Recognised food description' : 'What did you eat?'}</Text>
              {foodInputMode === 'photo' && !aiAnalysis && (
                <Text style={styles.sectionHint}>This becomes editable after AI identifies the food in your photo.</Text>
              )}
              <TextInput
                accessibilityLabel="Food description"
                editable={!isAiAnalysisLoading && (foodInputMode === 'text' || Boolean(aiAnalysis))}
                multiline
                onChangeText={updateFoodDescription}
                placeholder={foodInputMode === 'photo' ? 'Food identification will appear here' : 'e.g. chicken burrito with avocado'}
                placeholderTextColor="#AEB7D6"
                style={styles.foodDescriptionInput}
                textAlignVertical="top"
                value={foodDescription}
              />
            </GlassSurface>

            <GlassSurface style={styles.sectionCard}>
              <View style={styles.sectionTitleRow}>
                <Text style={styles.sectionTitle}>Spicy level</Text>
                {spiceLevel > 0 && (
                  <Pressable
                    accessibilityLabel="Clear spicy level"
                    accessibilityRole="button"
                    onPress={() => setSpiceLevel(0)}
                    style={({ pressed }) => [styles.clearSpiceButton, pressed && styles.pressedTile]}>
                    <Text style={styles.clearSpiceLabel}>Clear</Text>
                  </Pressable>
                )}
              </View>
              <Text style={styles.sectionHint}>Tap the number of chillies that feels right.</Text>
              <View accessibilityLabel="Spicy level" accessibilityRole="adjustable" style={styles.chilliGrid}>
                {Array.from({ length: 10 }, (_, index) => index + 1).map((level) => (
                  <Pressable
                    accessibilityLabel={`${level} chillies`}
                    accessibilityRole="button"
                    key={level}
                    onPress={() => setSpiceLevel(level)}
                    style={({ pressed }) => [styles.chilliButton, pressed && styles.pressedTile]}>
                    <Text style={[styles.chilli, level <= spiceLevel ? styles.selectedChilli : styles.unselectedChilli]}>🌶</Text>
                    <Text style={[styles.chilliNumber, level <= spiceLevel && styles.selectedChilliNumber]}>{level}</Text>
                  </Pressable>
                ))}
              </View>
            </GlassSurface>

            <Pressable
              accessibilityRole="button"
              disabled={isAiAnalysisLoading}
              onPress={() => void analyseFoodWithAi()}
              style={({ pressed }) => [
                styles.analyseButton,
                { backgroundColor: activeTheme.accent },
                isAiAnalysisLoading && styles.disabledAnalyseButton,
                pressed && styles.pressedTile,
              ]}>
              <Text style={styles.analyseButtonLabel}>
                {isAiAnalysisLoading ? 'Analysing…' : aiAnalysis ? 'Refresh AI estimate' : 'Analyse with AI'}
              </Text>
            </Pressable>

            <GlassSurface style={styles.calorieCard}>
              <Text style={styles.previewLabel}>PRIVATE ANALYSIS RESULT</Text>
              {aiAnalysis ? (
                <>
                  <Text style={styles.caloriePlaceholder}>{aiAnalysis.estimatedCalories} kcal</Text>
                  <Text style={styles.previewBody}>
                    Approx. {aiAnalysis.calorieRange.low}–{aiAnalysis.calorieRange.high} kcal · {aiAnalysis.confidence} confidence
                    {aiAnalysis.mealStyle ? ` · ${aiAnalysis.mealStyle} meal` : ''}
                  </Text>
                  <Text style={styles.analysisSummary}>{aiAnalysis.summary}</Text>
                  {aiAnalysis.macronutrients && (
                    <View style={styles.macroGrid}>
                      <MacroValue label="Protein" value={`${aiAnalysis.macronutrients.proteinGrams} g`} />
                      <MacroValue label="Carbs" value={`${aiAnalysis.macronutrients.carbohydratesGrams} g`} />
                      <MacroValue label="Fat" value={`${aiAnalysis.macronutrients.fatGrams} g`} />
                      <MacroValue label="Fibre" value={`${aiAnalysis.macronutrients.fibreGrams} g`} />
                    </View>
                  )}
                  {aiAnalysis.recommendations && (
                    <View style={styles.recommendationGroup}>
                      <Text style={styles.recommendationTitle}>Food ideas for you</Text>
                      <RecommendationRow label="Flavour" value={aiAnalysis.recommendations.flavorPairing} />
                      <RecommendationRow label="Spice" value={aiAnalysis.recommendations.spicePairing} />
                      <RecommendationRow label="Cuisine" value={aiAnalysis.recommendations.cuisineAlternative} />
                      <RecommendationRow label="Balance" value={aiAnalysis.recommendations.balancedPairing} />
                      <RecommendationRow label="Lighter" value={aiAnalysis.recommendations.lighterOption} />
                      {aiAnalysis.mealIdeas && aiAnalysis.mealIdeas.length > 0 && (
                        <View style={styles.mealIdeasGroup}>
                          <Text style={styles.mealIdeasTitle}>Complete meal ideas</Text>
                          {aiAnalysis.mealIdeas.map((idea, index) => (
                            <MealIdeaCard idea={idea} key={`${idea.title}-${index}`} />
                          ))}
                        </View>
                      )}
                    </View>
                  )}
                </>
              ) : (
                <>
                  <Text style={styles.caloriePlaceholder}>Ready to analyse your food</Text>
                  <Text style={styles.previewBody}>{aiAnalysisStatus || 'Your private AI estimate will appear here.'}</Text>
                </>
              )}
            </GlassSurface>

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !aiAnalysis || isSavingFoodEntry || Boolean(savedFoodEntryId) }}
              disabled={!aiAnalysis || isSavingFoodEntry || Boolean(savedFoodEntryId)}
              onPress={() => void saveFoodEntry()}
              style={({ pressed }) => [
                styles.saveButton,
                { backgroundColor: activeTheme.accent },
                (!aiAnalysis || isSavingFoodEntry || Boolean(savedFoodEntryId)) && styles.disabledSaveButton,
                pressed && styles.pressedTile,
              ]}>
              <Text style={styles.saveButtonLabel}>
                {isSavingFoodEntry ? 'Saving entry…' : savedFoodEntryId ? 'Entry saved' : 'Save entry'}
              </Text>
            </Pressable>
          </ScrollView>
        )}

        {!isSettingsOpen && (
          <GlassSurface style={styles.tabBar}>
            <TabButton active={isPhysical} label="Physical" onPress={() => setActiveTab('physical')} />
            <TabButton active={!isPhysical} label="Food" onPress={() => setActiveTab('food')} />
          </GlassSurface>
        )}
      </SafeAreaView>

      <Modal
        animationType="fade"
        transparent
        visible={Boolean(pendingItchEntry)}
        onRequestClose={() => undefined}>
        <View style={styles.itchOverlay}>
          <View style={styles.itchModal}>
            <Text style={styles.itchTitle}>What is your itch level at the moment?</Text>
            <Text style={styles.itchHint}>Choose 0 for no itch and 10 for the most intense itch.</Text>
            <View accessibilityLabel="Itch level" accessibilityRole="adjustable" style={styles.itchLevelGrid}>
              {Array.from({ length: 11 }, (_, level) => (
                <Pressable
                  accessibilityLabel={`Itch level ${level}`}
                  accessibilityRole="button"
                  key={level}
                  onPress={() => setSelectedItchLevel(level)}
                  style={({ pressed }) => [
                    styles.itchLevelButton,
                    selectedItchLevel === level && { backgroundColor: activeTheme.accent },
                    pressed && styles.pressedTile,
                  ]}>
                  <Text style={styles.itchLevelLabel}>{level}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={selectedItchLevel === null || isSavingFoodEntry}
              onPress={() => void saveItchLevel()}
              style={({ pressed }) => [
                styles.itchSaveButton,
                { backgroundColor: activeTheme.accent },
                (selectedItchLevel === null || isSavingFoodEntry) && styles.disabledSaveButton,
                pressed && styles.pressedTile,
              ]}>
              <Text style={styles.itchSaveLabel}>{isSavingFoodEntry ? 'Saving…' : 'Save itch level'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

    </View>
  );
}

function MacroValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.macroValue}>
      <Text style={styles.macroLabel}>{label}</Text>
      <Text style={styles.macroAmount}>{value}</Text>
    </View>
  );
}

function RecommendationRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.recommendationRow}>
      <Text style={styles.recommendationLabel}>{label}</Text>
      <Text style={styles.recommendationValue}>{value}</Text>
    </View>
  );
}

function MealIdeaCard({ idea }: { idea: NonNullable<FoodAnalysis['mealIdeas']>[number] }) {
  return (
    <View style={styles.mealIdeaCard}>
      <Text style={styles.mealIdeaTitle}>{idea.title}</Text>
      <Text style={styles.mealIdeaFoods}>{idea.foods.join(' · ')}</Text>
      <Text style={styles.mealIdeaReason}>{idea.reason}</Text>
    </View>
  );
}

function SwipeToDeleteRow({ children, onDelete }: { children: ReactNode; onDelete: () => void }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const rowWidth = useRef(1);
  const isDeleting = useRef(false);
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const close = () => Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
  const deleteWithSwipe = () => {
    isDeleting.current = true;
    Animated.timing(translateX, { duration: 180, toValue: -rowWidth.current, useNativeDriver: true }).start(({ finished }) => {
      if (finished) {
        onDeleteRef.current();
      } else {
        isDeleting.current = false;
        close();
      }
    });
  };
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_, gesture) => translateX.setValue(Math.max(-rowWidth.current, Math.min(0, gesture.dx))),
      onPanResponderRelease: (_, gesture) => {
        if (!isDeleting.current && (gesture.dx < -(rowWidth.current * 0.38) || gesture.vx < -0.8)) {
          deleteWithSwipe();
        } else {
          close();
        }
      },
      onPanResponderTerminate: close,
    }),
  ).current;

  return (
    <View onLayout={(event) => { rowWidth.current = event.nativeEvent.layout.width; }} style={styles.swipeRow}>
      <View style={styles.swipeDeleteBackground} />
      <Animated.View {...panResponder.panHandlers} style={[styles.swipeContent, { transform: [{ translateX }] }]}>
        {children}
      </Animated.View>
    </View>
  );
}

function CheckRow({ checked, label, onPress }: { checked: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.checkRow, pressed && styles.pressedTile]}>
      <Text style={styles.checkRowLabel}>{label}</Text>
      <View style={[styles.checkMark, checked && styles.checkedMark]}>
        {checked && <Text style={styles.checkMarkText}>✓</Text>}
      </View>
    </Pressable>
  );
}

function ChoiceSelect({
  accessibilityLabel,
  formatOption = (option) => option,
  onChange,
  options,
  value,
}: {
  accessibilityLabel: string;
  formatOption?: (option: string) => string;
  onChange: (value: string) => void;
  options: readonly string[];
  value: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.selectField, pressed && styles.pressedTile]}>
        <Text style={styles.selectValue}>{formatOption(value)}</Text>
        <Text style={styles.selectChevron}>⌄</Text>
      </Pressable>
      <Modal animationType="fade" transparent visible={open} onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.selectOverlay}>
          <Pressable onPress={(event) => event.stopPropagation()} style={styles.selectModal}>
            <Text style={styles.selectModalTitle}>{accessibilityLabel}</Text>
            <ScrollView bounces showsVerticalScrollIndicator={false} style={styles.selectList}>
              {options.map((option) => (
                <Pressable
                  accessibilityRole="button"
                  key={option}
                  onPress={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                  style={({ pressed }) => [styles.selectOption, option === value && styles.selectedOption, pressed && styles.pressedTile]}>
                  <Text style={[styles.selectOptionLabel, option === value && styles.selectedOptionLabel]}>{formatOption(option)}</Text>
                  {option === value && <Text style={styles.optionCheck}>✓</Text>}
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function WaterUnitToggle({
  accent,
  compact = false,
  onChange,
  value,
}: {
  accent: string;
  compact?: boolean;
  onChange: (unit: WaterUnit) => void;
  value: WaterUnit;
}) {
  return (
    <View accessibilityLabel="Water measurement unit" style={[styles.waterUnitToggle, compact && styles.waterUnitToggleCompact]}>
      {waterUnitOptions.map((unit) => (
        <Pressable
          accessibilityLabel={`Use ${formatWaterUnit(unit)}`}
          accessibilityRole="button"
          key={unit}
          onPress={() => onChange(unit)}
          style={({ pressed }) => [
            styles.waterUnitOption,
            compact && styles.waterUnitOptionCompact,
            unit === value && { backgroundColor: accent },
            pressed && styles.pressedTile,
          ]}>
          <Text style={[styles.waterUnitOptionLabel, compact && styles.waterUnitOptionLabelCompact, unit === value && styles.waterUnitOptionLabelSelected]}>
            {formatWaterUnit(unit)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function TabButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.tabButton, active && styles.activeTab, pressed && styles.pressedTab]}>
      <Text style={[styles.tabLabel, active && styles.activeTabLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: '#000000', overflow: 'hidden' },
  safeArea: { flex: 1, justifyContent: 'space-between' },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 48 },
  formScroll: { flex: 1 },
  scrollContent: { paddingBottom: 112, paddingHorizontal: 24, paddingTop: 48 },
  foodScrollContent: { paddingBottom: 112, paddingHorizontal: 24, paddingTop: 48 },
  settingsScrollContent: { paddingBottom: 48, paddingHorizontal: 24, paddingTop: 24 },
  compactScrollContent: { paddingHorizontal: 18, paddingTop: 34 },
  compactSettingsScrollContent: { paddingHorizontal: 18, paddingTop: 18 },
  pageHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  settingsButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderColor: 'rgba(255, 255, 255, 0.24)',
    borderRadius: 17,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  settingsIcon: { color: '#FFFFFF', fontSize: 21, lineHeight: 24 },
  settingsHeader: { alignItems: 'center', flexDirection: 'row', minHeight: 46 },
  settingsHeaderTitle: { color: '#FFFFFF', fontSize: 30, fontWeight: '700', letterSpacing: -0.8, marginLeft: 14 },
  backButton: { paddingHorizontal: 2, paddingVertical: 10 },
  backButtonLabel: { color: '#E8EBFA', fontSize: 16, fontWeight: '700' },
  eyebrow: { color: '#BFC6E4', fontSize: 11, fontWeight: '700', letterSpacing: 1.4 },
  title: { color: '#FFFFFF', fontSize: 38, fontWeight: '700', letterSpacing: -1.1, marginTop: 8 },
  currentDayLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginTop: 10 },
  subtitle: { color: '#D2D7EB', fontSize: 16, lineHeight: 23, marginTop: 10 },
  previewCard: {
    minHeight: 218,
    borderRadius: 30,
    justifyContent: 'flex-end',
    marginTop: 44,
    overflow: 'hidden',
    padding: 24,
  },
  glassFallback: { backgroundColor: 'rgba(255, 255, 255, 0.14)', borderColor: 'rgba(255, 255, 255, 0.25)', borderWidth: 1 },
  previewLabel: { color: '#DDE2FA', fontSize: 11, fontWeight: '700', letterSpacing: 1.1 },
  previewTitle: { color: '#FFFFFF', fontSize: 24, fontWeight: '700', letterSpacing: -0.5, marginTop: 8 },
  previewBody: { color: '#EEF0FA', fontSize: 15, lineHeight: 21, marginTop: 7 },
  sectionCard: { borderRadius: 26, marginTop: 18, overflow: 'hidden', padding: 20 },
  inputModeCard: { borderRadius: 26, marginTop: 18, overflow: 'hidden', padding: 16 },
  inputModeRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  inputModeButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.16)',
    borderColor: 'rgba(255, 255, 255, 0.18)',
    borderRadius: 15,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 12,
  },
  selectedInputModeButton: { backgroundColor: 'rgba(215, 202, 255, 0.34)', borderColor: 'rgba(255, 255, 255, 0.45)' },
  inputModeLabel: { color: '#CCD2E9', fontSize: 15, fontWeight: '700' },
  selectedInputModeLabel: { color: '#FFFFFF' },
  sectionTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '700', letterSpacing: -0.3 },
  sectionTitleRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  clearSpiceButton: { paddingHorizontal: 3, paddingVertical: 5 },
  clearSpiceLabel: { color: '#DDE2FA', fontSize: 13, fontWeight: '700' },
  sectionHint: { color: '#C4CAE0', fontSize: 13, lineHeight: 19, marginTop: 5 },
  settingsHint: { color: '#AEB7D6', fontSize: 12, lineHeight: 18, marginTop: 10 },
  addEssentialButton: { paddingHorizontal: 3, paddingVertical: 5 },
  addEssentialLabel: { color: '#DDE2FA', fontSize: 13, fontWeight: '700' },
  essentialComposer: {
    backgroundColor: 'rgba(0, 0, 0, 0.14)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 15,
    borderWidth: 1,
    marginTop: 8,
    padding: 10,
  },
  essentialInput: { color: '#FFFFFF', fontSize: 15, paddingHorizontal: 7, paddingVertical: 8 },
  essentialComposerActions: { flexDirection: 'row', gap: 9, justifyContent: 'flex-end', marginTop: 5 },
  essentialCancelButton: { paddingHorizontal: 10, paddingVertical: 8 },
  essentialCancelLabel: { color: '#CDD4EB', fontSize: 13, fontWeight: '700' },
  essentialSaveButton: { backgroundColor: 'rgba(215, 202, 255, 0.9)', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  essentialSaveLabel: { color: '#27203F', fontSize: 13, fontWeight: '800' },
  waterGoalHeader: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between', marginTop: 7 },
  waterGoalLabel: { color: '#C9D0E8', fontSize: 13, fontWeight: '700' },
  waterProgressTrack: { backgroundColor: 'rgba(255, 255, 255, 0.14)', borderRadius: 999, height: 8, marginTop: 13, overflow: 'hidden' },
  waterProgressFill: { borderRadius: 999, height: '100%' },
  waterGoalStatus: { color: '#DDE2F2', fontSize: 13, fontWeight: '600', marginTop: 8 },
  waterLog: { borderTopColor: 'rgba(255, 255, 255, 0.14)', borderTopWidth: 1, marginTop: 18, paddingTop: 14 },
  waterLogTitle: { color: '#DDE2F2', fontSize: 13, fontWeight: '800', marginBottom: 5 },
  waterLogContent: { backgroundColor: 'rgba(0, 0, 0, 0.11)', width: '100%' },
  waterLogRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 58,
    paddingHorizontal: 12,
  },
  waterLogAmount: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  waterLogTime: { color: '#B9C2DA', fontSize: 12, marginTop: 3 },
  waterLogChevron: { color: '#BFC7DF', fontSize: 27, fontWeight: '400', lineHeight: 27 },
  waterInlineEditor: {
    alignItems: 'center',
    borderTopColor: 'rgba(255, 255, 255, 0.12)',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  waterInlineInput: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 10,
    borderWidth: 1,
    color: '#FFFFFF',
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    minWidth: 54,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  waterInlineUnit: { color: '#BFC8DE', fontSize: 12, fontWeight: '700' },
  waterInlineCancelButton: { paddingHorizontal: 4, paddingVertical: 8 },
  waterInlineCancelLabel: { color: '#CED5E9', fontSize: 12, fontWeight: '700' },
  waterInlineSaveButton: { backgroundColor: 'rgba(215, 202, 255, 0.92)', borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8 },
  waterInlineSaveLabel: { color: '#29213F', fontSize: 12, fontWeight: '800' },
  hydrationReminderHint: { color: '#AEB7D6', fontSize: 12, lineHeight: 17, marginTop: 6 },
  swipeRow: { borderRadius: 14, marginTop: 7, overflow: 'hidden', width: '100%' },
  swipeDeleteBackground: { backgroundColor: 'rgba(77, 64, 109, 0.96)', bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  swipeContent: { width: '100%' },
  pressedTile: { opacity: 0.7 },
  checkMark: {
    alignItems: 'center',
    borderColor: '#C9D0E8',
    borderRadius: 7,
    borderWidth: 1.5,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  checkedMark: { backgroundColor: '#FFFFFF', borderColor: '#FFFFFF' },
  checkMarkText: { color: '#4A417A', fontSize: 13, fontWeight: '900', lineHeight: 15 },
  checkRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 15 },
  checkRowLabel: { color: '#F6F7FD', fontSize: 16, fontWeight: '500' },
  inputLabel: { color: '#D8DDED', fontSize: 14, fontWeight: '600', marginTop: 15 },
  secondInputLabel: { marginTop: 8 },
  selectField: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.14)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 15,
    borderWidth: 1,
    height: 54,
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 11,
    overflow: 'hidden',
  },
  selectValue: { color: '#FFFFFF', flex: 1, fontSize: 16, fontWeight: '600', paddingHorizontal: 15 },
  selectChevron: { color: '#DDE2F2', fontSize: 22, lineHeight: 24, marginRight: 15, marginTop: -5 },
  selectOverlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.62)',
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  selectModal: {
    backgroundColor: '#222536',
    borderColor: 'rgba(255, 255, 255, 0.22)',
    borderRadius: 24,
    borderWidth: 1,
    maxHeight: '72%',
    overflow: 'hidden',
    padding: 10,
    width: '100%',
  },
  selectModalTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', paddingHorizontal: 12, paddingVertical: 12 },
  selectList: { maxHeight: 360 },
  selectOption: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 14 },
  selectedOption: { backgroundColor: 'rgba(198, 184, 255, 0.25)' },
  selectOptionLabel: { color: '#E2E5F0', fontSize: 16, fontWeight: '600' },
  selectedOptionLabel: { color: '#FFFFFF' },
  optionCheck: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  accessTokenInput: {
    backgroundColor: 'rgba(0, 0, 0, 0.14)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 14,
    borderWidth: 1,
    color: '#FFFFFF',
    fontSize: 15,
    marginTop: 15,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  accessTokenButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    borderColor: 'rgba(255, 255, 255, 0.28)',
    borderRadius: 13,
    borderWidth: 1,
    marginTop: 11,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  disabledAccessTokenButton: { opacity: 0.55 },
  accessTokenButtonLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  aiUsageCard: { borderRadius: 26, marginTop: 18, overflow: 'hidden', padding: 20 },
  aiUsageHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  aiUsageTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '700', letterSpacing: -0.3, marginTop: 6 },
  refreshUsageButton: { paddingHorizontal: 2, paddingVertical: 7 },
  refreshUsageLabel: { color: '#E7E9FF', fontSize: 13, fontWeight: '700' },
  aiUsageTrack: {
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    borderRadius: 99,
    height: 9,
    marginTop: 17,
    overflow: 'hidden',
  },
  aiUsageFill: { backgroundColor: '#D7CAFF', borderRadius: 99, height: '100%' },
  aiUsageFillAtLimit: { backgroundColor: '#FF9DBA' },
  aiUsageHint: { color: '#C4CAE0', fontSize: 13, lineHeight: 19, marginTop: 9 },
  waterInputRow: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.14)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 17,
    borderWidth: 1,
    flexDirection: 'row',
    marginTop: 15,
    paddingHorizontal: 15,
  },
  waterInput: { color: '#FFFFFF', flex: 1, fontSize: 20, fontWeight: '600', minWidth: 54, paddingVertical: 14 },
  waterUnitToggle: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    marginLeft: 8,
    overflow: 'hidden',
  },
  waterUnitToggleCompact: { marginLeft: 0 },
  waterUnitOption: { minWidth: 35, paddingHorizontal: 7, paddingVertical: 8 },
  waterUnitOptionCompact: { minWidth: 31, paddingHorizontal: 5, paddingVertical: 7 },
  waterUnitOptionLabel: { color: '#C7CEE6', fontSize: 12, fontWeight: '800', textAlign: 'center' },
  waterUnitOptionLabelCompact: { fontSize: 11 },
  waterUnitOptionLabelSelected: { color: '#30294B' },
  waterTotal: { color: '#E8E9F4', fontSize: 15, fontWeight: '700', marginTop: 6 },
  waterAddButton: {
    backgroundColor: 'rgba(214, 205, 255, 0.92)',
    borderRadius: 12,
    marginLeft: 11,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  waterAddLabel: { color: '#30294B', fontSize: 14, fontWeight: '800' },
  dailySyncHint: { color: '#C4CAE0', fontSize: 12, lineHeight: 18, marginTop: 10 },
  foodDescriptionInput: {
    backgroundColor: 'rgba(0, 0, 0, 0.14)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 17,
    borderWidth: 1,
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 22,
    marginTop: 15,
    minHeight: 100,
    padding: 14,
  },
  photoSectionCard: { paddingBottom: 16, paddingTop: 16 },
  compactImageSelectButton: {
    alignItems: 'center',
    borderColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 19,
    borderStyle: 'dashed',
    borderWidth: 1.5,
    justifyContent: 'center',
    marginTop: 15,
    minHeight: 98,
    padding: 12,
  },
  compactImageSelectIcon: { color: '#FFFFFF', fontSize: 25, fontWeight: '300', lineHeight: 27 },
  imageSelectTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginTop: 6 },
  imageSelectHint: { color: '#C4CAE0', fontSize: 13, marginTop: 4 },
  compactImagePreviewWrap: { marginTop: 15 },
  compactImagePreview: { borderRadius: 16, height: 132, width: '100%' },
  changeImageButton: { alignSelf: 'center', paddingHorizontal: 12, paddingTop: 12 },
  changeImageLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  chilliGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 17 },
  chilliButton: { alignItems: 'center', minWidth: 45 },
  chilli: { fontSize: 23 },
  selectedChilli: { opacity: 1 },
  unselectedChilli: { opacity: 0.25 },
  chilliNumber: { color: '#9FA9CB', fontSize: 11, fontWeight: '700', marginTop: 2 },
  selectedChilliNumber: { color: '#FFFFFF' },
  calorieCard: { borderRadius: 26, marginTop: 18, overflow: 'hidden', padding: 20 },
  caloriePlaceholder: { color: '#FFFFFF', fontSize: 22, fontWeight: '700', letterSpacing: -0.4, marginTop: 8 },
  analysisSummary: { color: '#E6E9F6', fontSize: 13, lineHeight: 19, marginTop: 10 },
  macroGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  macroValue: {
    backgroundColor: 'rgba(0, 0, 0, 0.18)',
    borderColor: 'rgba(255, 255, 255, 0.13)',
    borderRadius: 12,
    borderWidth: 1,
    minWidth: '47%',
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  macroLabel: { color: '#AEB7D6', fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  macroAmount: { color: '#FFFFFF', fontSize: 17, fontWeight: '800', marginTop: 3 },
  recommendationGroup: {
    borderTopColor: 'rgba(255, 255, 255, 0.14)',
    borderTopWidth: 1,
    marginTop: 18,
    paddingTop: 15,
  },
  recommendationTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginBottom: 7 },
  recommendationRow: { flexDirection: 'row', marginTop: 8 },
  recommendationLabel: { color: '#B8C0D9', fontSize: 12, fontWeight: '800', width: 58 },
  recommendationValue: { color: '#E8EBF7', flex: 1, fontSize: 12, lineHeight: 17 },
  mealIdeasGroup: { marginTop: 17 },
  mealIdeasTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', marginBottom: 8 },
  mealIdeaCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderColor: 'rgba(255, 255, 255, 0.13)',
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 8,
    padding: 12,
  },
  mealIdeaTitle: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  mealIdeaFoods: { color: '#BFD4F3', fontSize: 12, fontWeight: '700', lineHeight: 18, marginTop: 4 },
  mealIdeaReason: { color: '#E8EBF7', fontSize: 12, lineHeight: 17, marginTop: 5 },
  analyseButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(177, 214, 255, 0.92)',
    borderRadius: 19,
    marginTop: 14,
    paddingVertical: 16,
  },
  disabledAnalyseButton: { opacity: 0.62 },
  analyseButtonLabel: { color: '#17223D', fontSize: 16, fontWeight: '800' },
  saveButton: {
    alignItems: 'center',
    borderRadius: 19,
    marginTop: 18,
    paddingVertical: 17,
  },
  disabledSaveButton: { opacity: 0.5 },
  saveButtonLabel: { color: '#292141', fontSize: 17, fontWeight: '800' },
  itchOverlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  itchModal: {
    backgroundColor: '#202331',
    borderColor: 'rgba(255, 255, 255, 0.24)',
    borderRadius: 26,
    borderWidth: 1,
    padding: 22,
    width: '100%',
  },
  itchTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '700', letterSpacing: -0.5, lineHeight: 28 },
  itchHint: { color: '#C9D0E5', fontSize: 14, lineHeight: 20, marginTop: 8 },
  itchLevelGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 20 },
  itchLevelButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.11)',
    borderColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 12,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  itchLevelLabel: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  itchSaveButton: { alignItems: 'center', borderRadius: 16, marginTop: 22, paddingVertical: 15 },
  itchSaveLabel: { color: '#292141', fontSize: 16, fontWeight: '800' },
  tabBar: {
    alignSelf: 'center',
    borderRadius: 24,
    flexDirection: 'row',
    gap: 7,
    marginBottom: 18,
    overflow: 'hidden',
    padding: 6,
    width: '88%',
  },
  tabButton: { alignItems: 'center', borderRadius: 18, flex: 1, paddingVertical: 14 },
  activeTab: { backgroundColor: 'rgba(255, 255, 255, 0.28)' },
  pressedTab: { opacity: 0.72 },
  tabLabel: { color: '#C5CBE2', fontSize: 15, fontWeight: '600' },
  activeTabLabel: { color: '#FFFFFF' },
});
