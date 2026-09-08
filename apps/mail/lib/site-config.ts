const TITLE = "Varun's Mail";
const DESCRIPTION = "Varun's private mail client.";

export const siteConfig = {
  title: TITLE,
  description: DESCRIPTION,
  icons: {
    icon: '/assets/mail.svg',
  },
  applicationName: "Varun's Mail",
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
  },
  category: 'Email Client',
  alternates: {
    canonical: import.meta.env.VITE_PUBLIC_APP_URL,
  },
};
