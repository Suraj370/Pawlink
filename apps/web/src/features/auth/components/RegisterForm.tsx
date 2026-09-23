import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input, Label } from "@/components/ui/input"
import { toErrorMessage } from "@/lib/api/errors"
import { useRegister } from "../hooks"
import { registerSchema } from "../schemas"

type Props = {
  onSuccess: () => void
}

export function RegisterForm({ onSuccess }: Props) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [password, setPassword] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const register = useRegister()

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFieldError(null)
    setSubmitError(null)

    const parsed = registerSchema.safeParse({ name, email, phone, password })
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Invalid input")
      return
    }

    try {
      await register.mutateAsync(parsed.data)
      onSuccess()
    } catch (err) {
      setSubmitError(await toErrorMessage(err, "Registration failed"))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <Label>
        Name
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
        />
      </Label>
      <Label>
        Email
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
      </Label>
      <Label>
        Phone
        <Input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="tel"
          required
        />
      </Label>
      <Label>
        Password
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
      </Label>
      {(fieldError ?? submitError) && (
        <p role="alert" className="text-sm text-destructive" data-testid="register-error">
          {fieldError ?? submitError}
        </p>
      )}
      <Button type="submit" isDisabled={register.isPending} className="mt-2 h-10 w-full">
        {register.isPending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  )
}
