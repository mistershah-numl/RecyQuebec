export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      ai_services: {
        Row: {
          api_key: string
          base_url: string
          created_at: string
          id: string
          models: string[]
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          api_key: string
          base_url: string
          created_at?: string
          id?: string
          models?: string[]
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          api_key?: string
          base_url?: string
          created_at?: string
          id?: string
          models?: string[]
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      batch_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          end_row: number
          error: string | null
          file_name: string | null
          id: string
          invalid_count: number
          lease_until: string | null
          model: string
          name: string
          paused_reason: string | null
          processed_rows: number
          source_headers: Json
          start_row: number
          started_at: string | null
          status: string
          targets: Json
          total_rows: number
          updated_at: string
          user_id: string
          valid_emails: number
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          end_row?: number
          error?: string | null
          file_name?: string | null
          id?: string
          invalid_count?: number
          lease_until?: string | null
          model?: string
          name: string
          paused_reason?: string | null
          processed_rows?: number
          source_headers?: Json
          start_row?: number
          started_at?: string | null
          status?: string
          targets?: Json
          total_rows?: number
          updated_at?: string
          user_id: string
          valid_emails?: number
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          end_row?: number
          error?: string | null
          file_name?: string | null
          id?: string
          invalid_count?: number
          lease_until?: string | null
          model?: string
          name?: string
          paused_reason?: string | null
          processed_rows?: number
          source_headers?: Json
          start_row?: number
          started_at?: string | null
          status?: string
          targets?: Json
          total_rows?: number
          updated_at?: string
          user_id?: string
          valid_emails?: number
        }
        Relationships: []
      }
      contacts: {
        Row: {
          address: string | null
          city: string | null
          company_name: string
          company_status: string | null
          confidence: number
          created_at: string
          domain: string | null
          email: string | null
          email_type: string | null
          executive_name: string | null
          facebook_url: string | null
          id: string
          job_id: string | null
          linkedin_url: string | null
          neq: string | null
          phone: string | null
          postal_code: string | null
          registry_url: string | null
          source: string | null
          source_row: Json
          title: string | null
          user_id: string
          verification_details: Json
          verification_status: string
        }
        Insert: {
          address?: string | null
          city?: string | null
          company_name: string
          company_status?: string | null
          confidence?: number
          created_at?: string
          domain?: string | null
          email?: string | null
          email_type?: string | null
          executive_name?: string | null
          facebook_url?: string | null
          id?: string
          job_id?: string | null
          linkedin_url?: string | null
          neq?: string | null
          phone?: string | null
          postal_code?: string | null
          registry_url?: string | null
          source?: string | null
          source_row?: Json
          title?: string | null
          user_id: string
          verification_details?: Json
          verification_status?: string
        }
        Update: {
          address?: string | null
          city?: string | null
          company_name?: string
          company_status?: string | null
          confidence?: number
          created_at?: string
          domain?: string | null
          email?: string | null
          email_type?: string | null
          executive_name?: string | null
          facebook_url?: string | null
          id?: string
          job_id?: string | null
          linkedin_url?: string | null
          neq?: string | null
          phone?: string | null
          postal_code?: string | null
          registry_url?: string | null
          source?: string | null
          source_row?: Json
          title?: string | null
          user_id?: string
          verification_details?: Json
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "batch_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_contacts: {
        Row: {
          city: string | null
          company_name: string
          contact_name: string | null
          created_at: string
          domain: string | null
          email: string | null
          extra: Json
          id: string
          neq: string | null
          notes: string | null
          phone: string | null
          source: string | null
          source_contact_id: string | null
          source_job_id: string | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          city?: string | null
          company_name: string
          contact_name?: string | null
          created_at?: string
          domain?: string | null
          email?: string | null
          extra?: Json
          id?: string
          neq?: string | null
          notes?: string | null
          phone?: string | null
          source?: string | null
          source_contact_id?: string | null
          source_job_id?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          city?: string | null
          company_name?: string
          contact_name?: string | null
          created_at?: string
          domain?: string | null
          email?: string | null
          extra?: Json
          id?: string
          neq?: string | null
          notes?: string | null
          phone?: string | null
          source?: string | null
          source_contact_id?: string | null
          source_job_id?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_contacts_source_job_id_fkey"
            columns: ["source_job_id"]
            isOneToOne: false
            referencedRelation: "batch_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      email_sends: {
        Row: {
          body: string
          company_name: string | null
          contact_name: string | null
          created_at: string
          crm_contact_id: string | null
          dry_run: boolean
          error: string | null
          from_email: string | null
          from_name: string | null
          id: string
          job_id: string | null
          reply_to: string | null
          status: string
          subject: string
          template_id: string | null
          to_email: string
          user_id: string
        }
        Insert: {
          body: string
          company_name?: string | null
          contact_name?: string | null
          created_at?: string
          crm_contact_id?: string | null
          dry_run?: boolean
          error?: string | null
          from_email?: string | null
          from_name?: string | null
          id?: string
          job_id?: string | null
          reply_to?: string | null
          status?: string
          subject: string
          template_id?: string | null
          to_email: string
          user_id: string
        }
        Update: {
          body?: string
          company_name?: string | null
          contact_name?: string | null
          created_at?: string
          crm_contact_id?: string | null
          dry_run?: boolean
          error?: string | null
          from_email?: string | null
          from_name?: string | null
          id?: string
          job_id?: string | null
          reply_to?: string | null
          status?: string
          subject?: string
          template_id?: string | null
          to_email?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_sends_crm_contact_id_fkey"
            columns: ["crm_contact_id"]
            isOneToOne: false
            referencedRelation: "crm_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_sends_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "batch_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_sends_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "email_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      email_templates: {
        Row: {
          body: string
          created_at: string
          id: string
          name: string
          subject: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          name: string
          subject: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          name?: string
          subject?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      job_logs: {
        Row: {
          created_at: string
          id: number
          job_id: string
          level: string
          message: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: number
          job_id: string
          level?: string
          message: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: number
          job_id?: string
          level?: string
          message?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_logs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "batch_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_rows: {
        Row: {
          attempts: number
          city: string | null
          claimed_at: string | null
          company_name: string
          created_at: string
          error: string | null
          heartbeat_at: string | null
          id: number
          job_id: string
          neq: string | null
          postal_code: string | null
          processed_at: string | null
          row_index: number
          source_row: Json
          status: string
          user_id: string
        }
        Insert: {
          attempts?: number
          city?: string | null
          claimed_at?: string | null
          company_name: string
          created_at?: string
          error?: string | null
          heartbeat_at?: string | null
          id?: number
          job_id: string
          neq?: string | null
          postal_code?: string | null
          processed_at?: string | null
          row_index: number
          source_row?: Json
          status?: string
          user_id: string
        }
        Update: {
          attempts?: number
          city?: string | null
          claimed_at?: string | null
          company_name?: string
          created_at?: string
          error?: string | null
          heartbeat_at?: string | null
          id?: number
          job_id?: string
          neq?: string | null
          postal_code?: string | null
          processed_at?: string | null
          row_index?: number
          source_row?: Json
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_rows_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "batch_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          anthropic_key: string | null
          batch_size: number | null
          custom_ai_base_url: string | null
          custom_ai_key: string | null
          custom_ai_models: string | null
          default_model: string
          email_daily_cap: number | null
          email_dry_run: boolean
          email_from_local: string | null
          email_reply_to: string | null
          email_sender_domain: string | null
          email_sender_name: string | null
          email_throttle_seconds: number | null
          gemini_key: string | null
          openai_key: string | null
          osint_worker_secret: string | null
          osint_worker_url: string | null
          perplexity_key: string | null
          row_timeout_seconds: number
          smtp_from_email: string | null
          smtp_host: string | null
          smtp_password: string | null
          smtp_port: number | null
          smtp_secure: string
          smtp_user: string | null
          smtp_verified_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          anthropic_key?: string | null
          batch_size?: number | null
          custom_ai_base_url?: string | null
          custom_ai_key?: string | null
          custom_ai_models?: string | null
          default_model?: string
          email_daily_cap?: number | null
          email_dry_run?: boolean
          email_from_local?: string | null
          email_reply_to?: string | null
          email_sender_domain?: string | null
          email_sender_name?: string | null
          email_throttle_seconds?: number | null
          gemini_key?: string | null
          openai_key?: string | null
          osint_worker_secret?: string | null
          osint_worker_url?: string | null
          perplexity_key?: string | null
          row_timeout_seconds?: number
          smtp_from_email?: string | null
          smtp_host?: string | null
          smtp_password?: string | null
          smtp_port?: number | null
          smtp_secure?: string
          smtp_user?: string | null
          smtp_verified_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          anthropic_key?: string | null
          batch_size?: number | null
          custom_ai_base_url?: string | null
          custom_ai_key?: string | null
          custom_ai_models?: string | null
          default_model?: string
          email_daily_cap?: number | null
          email_dry_run?: boolean
          email_from_local?: string | null
          email_reply_to?: string | null
          email_sender_domain?: string | null
          email_sender_name?: string | null
          email_throttle_seconds?: number | null
          gemini_key?: string | null
          openai_key?: string | null
          osint_worker_secret?: string | null
          osint_worker_url?: string | null
          perplexity_key?: string | null
          row_timeout_seconds?: number
          smtp_from_email?: string | null
          smtp_host?: string | null
          smtp_password?: string | null
          smtp_port?: number | null
          smtp_secure?: string
          smtp_user?: string | null
          smtp_verified_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_job_rows: {
        Args: { p_job_id: string; p_limit: number }
        Returns: {
          attempts: number
          city: string | null
          claimed_at: string | null
          company_name: string
          created_at: string
          error: string | null
          heartbeat_at: string | null
          id: number
          job_id: string
          neq: string | null
          postal_code: string | null
          processed_at: string | null
          row_index: number
          source_row: Json
          status: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "job_rows"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      recover_stale_job_rows: {
        Args: {
          p_job_id: string
          p_max_attempts?: number
          p_stale_before: string
        }
        Returns: {
          failed: number
          requeued: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
