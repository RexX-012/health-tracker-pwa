import { handleRequest } from '../backend/core/handleRequest';
import { BackendEnvironment } from '../backend/core/environment';
import { googleSheetsDailyRecordsStore } from '../backend/core/googleSheetsDailyRecords';

type ScheduledController = {
  scheduledTime: number;
  waitUntil(promise: Promise<unknown>): void;
};

export default {
  fetch(request: Request, environment: BackendEnvironment): Promise<Response> {
    return handleRequest(request, environment);
  },
  scheduled(controller: ScheduledController, environment: BackendEnvironment): void {
    controller.waitUntil(
      googleSheetsDailyRecordsStore.finalizeDueRecords(environment, controller.scheduledTime).catch((error) => {
        console.error('Daily record finalisation failed.', error);
      }),
    );
  },
};
