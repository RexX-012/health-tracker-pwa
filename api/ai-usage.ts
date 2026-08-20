import { BackendEnvironment } from '../backend/core/environment';
import { handleRequest } from '../backend/core/handleRequest';

const environment: BackendEnvironment = {
  APP_ACCESS_TOKEN: process.env.APP_ACCESS_TOKEN,
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

export default {
  fetch(request: Request): Promise<Response> {
    const publicUrl = new URL(request.url);
    publicUrl.pathname = '/ai-usage';
    return handleRequest(new Request(publicUrl, request), environment);
  },
};
