import { BackendEnvironment } from './environment';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const FOOD_ANALYSIS_MODEL = 'gpt-5.4-mini';

export type FoodAnalysisInput = {
  description?: string;
  image?: {
    base64: string;
    mediaType: string;
  };
};

export type FoodAnalysis = {
  estimatedCalories: number;
  calorieRange: {
    low: number;
    high: number;
  };
  confidence: 'low' | 'medium' | 'high';
  summary: string;
  items: Array<{
    name: string;
    estimatedCalories: number;
  }>;
  macronutrients: {
    carbohydratesGrams: number;
    fatGrams: number;
    fibreGrams: number;
    proteinGrams: number;
  };
  mealStyle: 'balanced' | 'hearty' | 'light';
  recognizedDescription: string;
  recommendations: {
    balancedPairing: string;
    cuisineAlternative: string;
    flavorPairing: string;
    lighterOption: string;
    spicePairing: string;
  };
  mealIdeas: Array<{
    foods: string[];
    reason: string;
    title: string;
  }>;
};

export class OpenAiFoodAnalysisError extends Error {
  constructor() {
    super('Food analysis could not be completed.');
    this.name = 'OpenAiFoodAnalysisError';
  }
}

/**
 * Keeps the OpenAI key and request entirely on the backend. The small, strict
 * response schema makes the result predictable for the mobile UI and bounds
 * the response size for this personal-use feature.
 */
export async function analyseFoodWithOpenAi(
  environment: BackendEnvironment,
  food: FoodAnalysisInput,
): Promise<FoodAnalysis> {
  const content: Array<Record<string, string>> = [
    {
      type: 'input_text',
      text: buildFoodPrompt(food.description),
    },
  ];

  if (food.image) {
    content.push({
      type: 'input_image',
      image_url: `data:${food.image.mediaType};base64,${food.image.base64}`,
    });
  }

  let response: Response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      body: JSON.stringify({
        input: [{ content, role: 'user' }],
        max_output_tokens: 800,
        model: FOOD_ANALYSIS_MODEL,
        reasoning: { effort: 'none' },
        store: false,
        text: {
          format: {
            name: 'food_calorie_estimate',
            schema: foodAnalysisSchema,
            strict: true,
            type: 'json_schema',
          },
        },
      }),
      headers: {
        Authorization: `Bearer ${environment.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
  } catch {
    throw new OpenAiFoodAnalysisError();
  }

  if (!response.ok) {
    throw new OpenAiFoodAnalysisError();
  }

  try {
    const payload = (await response.json()) as unknown;
    return parseFoodAnalysis(readOutputText(payload));
  } catch {
    throw new OpenAiFoodAnalysisError();
  }
}

const foodAnalysisSchema = {
  additionalProperties: false,
  properties: {
    calorieRange: {
      additionalProperties: false,
      properties: {
        high: { type: 'integer' },
        low: { type: 'integer' },
      },
      required: ['low', 'high'],
      type: 'object',
    },
    confidence: {
      enum: ['low', 'medium', 'high'],
      type: 'string',
    },
    estimatedCalories: { type: 'integer' },
    items: {
      items: {
        additionalProperties: false,
        properties: {
          estimatedCalories: { type: 'integer' },
          name: { type: 'string' },
        },
        required: ['name', 'estimatedCalories'],
        type: 'object',
      },
      type: 'array',
    },
    macronutrients: {
      additionalProperties: false,
      properties: {
        carbohydratesGrams: { type: 'integer' },
        fatGrams: { type: 'integer' },
        fibreGrams: { type: 'integer' },
        proteinGrams: { type: 'integer' },
      },
      required: ['proteinGrams', 'carbohydratesGrams', 'fatGrams', 'fibreGrams'],
      type: 'object',
    },
    mealStyle: {
      enum: ['light', 'balanced', 'hearty'],
      type: 'string',
    },
    mealIdeas: {
      items: {
        additionalProperties: false,
        properties: {
          foods: { items: { type: 'string' }, type: 'array' },
          reason: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['title', 'foods', 'reason'],
        type: 'object',
      },
      type: 'array',
    },
    recognizedDescription: { type: 'string' },
    recommendations: {
      additionalProperties: false,
      properties: {
        balancedPairing: { type: 'string' },
        cuisineAlternative: { type: 'string' },
        flavorPairing: { type: 'string' },
        lighterOption: { type: 'string' },
        spicePairing: { type: 'string' },
      },
      required: ['flavorPairing', 'spicePairing', 'cuisineAlternative', 'balancedPairing', 'lighterOption'],
      type: 'object',
    },
    summary: { type: 'string' },
  },
  required: [
    'estimatedCalories',
    'calorieRange',
    'confidence',
    'summary',
    'items',
    'recognizedDescription',
    'macronutrients',
    'mealStyle',
    'mealIdeas',
    'recommendations',
  ],
  type: 'object',
} as const;

function buildFoodPrompt(description?: string): string {
  const descriptionSection = description?.trim()
    ? `Food description supplied by the user:\n${description.trim()}`
    : 'No text description was supplied; estimate from the image only.';

  return [
    'Estimate the total calories in the pictured and/or described food.',
    descriptionSection,
    'Set recognizedDescription to a concise, editable name and description of the food you identify. When an image is provided, identify the pictured food rather than inventing ingredients that are not visible.',
    'Estimate macronutrients in grams for the total meal: protein, carbohydrates, fat, and fibre. Set mealStyle to light, balanced, or hearty.',
    'Give concise food suggestions for flavorPairing, spicePairing, cuisineAlternative, balancedPairing, and lighterOption. Keep suggestions practical and tied to the described food.',
    'Give exactly three mealIdeas. Each must be a distinct, complete meal built around foods that suit the analysed food and the flavour, spice, cuisine, balance, and lighter suggestions. Include 2 to 4 individual foods in foods, a short title, and one brief reason. Do not make medical, allergy, therapeutic, disease, or personalised health claims.',
    'Return approximate estimates only. Identify visible or described components, make sensible portion assumptions, and use a wider range when uncertain. Do not browse the web or use external tools.',
  ].join('\n\n');
}

function readOutputText(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new Error('Unexpected response');
  }
  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  const output = payload.output;
  if (!Array.isArray(output)) {
    throw new Error('Missing output');
  }
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  throw new Error('Missing output text');
}

function parseFoodAnalysis(value: string): FoodAnalysis {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || !isValidCalories(parsed.estimatedCalories) || !isRecord(parsed.calorieRange)
    || !isValidCalories(parsed.calorieRange.low) || !isValidCalories(parsed.calorieRange.high)
    || parsed.calorieRange.low > parsed.calorieRange.high
    || !isConfidence(parsed.confidence) || typeof parsed.summary !== 'string'
    || typeof parsed.recognizedDescription !== 'string' || parsed.recognizedDescription.trim().length === 0
    || !isMacronutrients(parsed.macronutrients) || !isMealStyle(parsed.mealStyle) || !isMealIdeas(parsed.mealIdeas) || !isRecommendations(parsed.recommendations)
    || !Array.isArray(parsed.items)) {
    throw new Error('Unexpected analysis');
  }

  const items = parsed.items.map((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || !isValidCalories(item.estimatedCalories)) {
      throw new Error('Unexpected item');
    }
    return { name: item.name, estimatedCalories: item.estimatedCalories };
  });

  return {
    calorieRange: { low: parsed.calorieRange.low, high: parsed.calorieRange.high },
    confidence: parsed.confidence,
    estimatedCalories: parsed.estimatedCalories,
    items,
    macronutrients: parsed.macronutrients,
    mealStyle: parsed.mealStyle,
    mealIdeas: parsed.mealIdeas,
    recognizedDescription: parsed.recognizedDescription.trim(),
    recommendations: parsed.recommendations,
    summary: parsed.summary,
  };
}

function isValidCalories(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000;
}

function isConfidence(value: unknown): value is FoodAnalysis['confidence'] {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isMacronutrients(value: unknown): value is FoodAnalysis['macronutrients'] {
  return isRecord(value)
    && isValidCalories(value.proteinGrams)
    && isValidCalories(value.carbohydratesGrams)
    && isValidCalories(value.fatGrams)
    && isValidCalories(value.fibreGrams);
}

function isMealStyle(value: unknown): value is FoodAnalysis['mealStyle'] {
  return value === 'light' || value === 'balanced' || value === 'hearty';
}

function isMealIdeas(value: unknown): value is FoodAnalysis['mealIdeas'] {
  return Array.isArray(value)
    && value.length === 3
    && value.every((idea) => isRecord(idea)
      && typeof idea.title === 'string' && idea.title.trim().length > 0
      && Array.isArray(idea.foods) && idea.foods.length >= 2 && idea.foods.length <= 4
      && idea.foods.every((food) => typeof food === 'string' && food.trim().length > 0)
      && typeof idea.reason === 'string' && idea.reason.trim().length > 0);
}

function isRecommendations(value: unknown): value is FoodAnalysis['recommendations'] {
  return isRecord(value)
    && typeof value.flavorPairing === 'string'
    && typeof value.spicePairing === 'string'
    && typeof value.cuisineAlternative === 'string'
    && typeof value.balancedPairing === 'string'
    && typeof value.lighterOption === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
