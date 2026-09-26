import { serve } from '../_shared/http.ts'
import { createHandler } from './handler.ts'

serve(createHandler())
