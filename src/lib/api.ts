import axios from 'axios'
import type { ApiResult, Settings } from '../types'

export async function fetchPhone(
  settings: Settings,
  awb: string
): Promise<ApiResult> {
  const normalizedAwb = String(awb)
  .trim()
  .replace(/\s+/g, '')
  .replace(/[^\d]/g, '')
  const resp = await axios.post<ApiResult>(
    '/api/awb-detail',
    {
      key: 'handphone',
      type: '-',
      awb_number: normalizedAwb,
      user_id: settings.userId,
    },
    {
      headers: {
        Authorization: `Bearer ${settings.bearerToken}`,
        'x-permission-token': settings.permissionToken,
      },
      validateStatus: () => true,
      timeout: 30000,
    }
  )

  return resp.data
}
